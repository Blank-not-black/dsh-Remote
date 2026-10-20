'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// 最小 DOM 执行真实组件，验证交互和网络请求，不依赖 UI 文本源码匹配。
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.hidden = false; this.disabled = false; this.attrs = {}; this._text = ''; this._value = '' }
  append(...nodes) {
    for (const node of nodes) {
      if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node)
      node.parent = this; this.children.push(node)
    }
  }
  insertBefore(node,before) {
    if(node.parent)node.parent.children=node.parent.children.filter(child=>child!==node)
    const index=this.children.indexOf(before)
    node.parent=this
    if(index<0)this.children.push(node);else this.children.splice(index,0,node)
  }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parent = null }); this.children = []; this._text = ''; this.append(...nodes) }
  set textContent(value) { this.replaceChildren(); this._text = value }
  get textContent() { return this._text + this.children.map(node => node.textContent).join('') }
  set innerHTML(value) { this.replaceChildren(); this.html = value }
  setAttribute(key, value) { this.attrs[key] = value }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
  click() { if (!this.disabled) return Promise.all((this.listeners.click || []).map(fn => fn())) }
  get options() { return this.children }
  get value() { return this._value || (this.tagName === 'select' ? this.children[0]?.value || '' : '') }
  set value(value) { this._value = value }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const healthy = { mode: 'gateway', host: '0.0.0.0', port: 8787, lanIPs: ['192.168.1.8', '100.64.1.8'], token: 'private-token', upstream: { reachable: true }, devices: [] }
function harness({ missing = false, fail = false, canStart = true } = {}) {
  const root = new Element('main'), requests = [], codes = [], calls = []
  const window = { I18N: { lang: 'zh' }, qrcode() { return { addData(value) { codes.push(value) }, make() {}, createSvgTag() { return '<svg></svg>' } } } }
  let missingPackage = missing
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/setup.js'), 'utf8'), {
    window, document: { createElement: tag => new Element(tag) }, URLSearchParams, AbortSignal,
    fetch: async (url, options) => {
      requests.push({ url, ...options })
      if (fail) throw Error('network failure')
      return url.includes('.apk') ? new Response(null, { status: missingPackage ? 404 : 200,
        headers: { 'content-length': '2097152', 'content-type': 'application/vnd.android.package-archive' } })
        : Response.json({ version: '0.8.0-rc.6', apkUrl: 'https://untrusted.invalid/app.apk' })
    }
  })
  const setup = window.DshSetup.mount(root, { base: '/remote/', canStart,
    start: () => calls.push('start'), console: () => calls.push('console'), deviceKey: () => calls.push('key') })
  function all(el = root) { return [el, ...el.children.flatMap(child => all(child))] }
  const find = (tag, text) => all().find(el => el.tagName === tag && el.textContent === text)
  return { root, setup, requests, codes, calls, find, all, window, available() { missingPackage = false } }
}

test('首次引导只探测本机包，展示体积，下载不会误报连接完成', async () => {
  const h = harness(); h.setup.update(healthy); await flush()
  assert.equal(h.root.children[0].open, true)
  assert.deepEqual(h.requests.map(r => r.url), ['/remote/dsh-remote.apk', '/remote/update.json?local=setup'])
  assert.equal(h.requests[0].method, 'HEAD')
  const link = h.find('a', '下载到当前设备')
  assert.equal(link.hidden, false); assert.equal(link.href, '/remote/dsh-remote.apk')
  assert.match(h.root.textContent, /0.8.0-rc.6 · 2.0 MB/)
  await link.click()
  assert.match(h.root.textContent, /已请求浏览器下载/)
  assert.match(h.root.textContent, /等待手机连接/)
  assert.doesNotMatch(h.root.textContent, /已检测到手机或浏览器在线/)
  assert.equal(h.requests.length, 2, '不预先把整个 APK 拉进浏览器内存')
})

test('下载码不含凭据，连接码由用户主动显示，并随地址和令牌更新', async () => {
  const h = harness(); h.setup.update(healthy); await flush()
  assert.equal(h.codes.length, 0, '未点击时不暴露连接码')
  await h.find('button', '用手机扫码下载').click()
  assert.equal(h.codes.at(-1), 'http://192.168.1.8:8787/dsh-remote.apk')
  assert.doesNotMatch(h.codes.at(-1), /token/)
  await h.find('button', '显示连接二维码').click()
  const pair = new URL(h.codes.at(-1))
  assert.equal(pair.protocol, 'dshremote:'); assert.equal(pair.searchParams.get('token'), 'private-token')
  assert.equal(pair.searchParams.get('server'), 'http://192.168.1.8:8787')
  const select = h.all().find(el => el.tagName === 'select'); select.value = 'http://100.64.1.8:8787'
  select.listeners.change[0]()
  assert.equal(new URL(h.codes.at(-1)).searchParams.get('server'), select.value)
  h.setup.update({ ...healthy, token: 'rotated' })
  assert.equal(new URL(h.codes.at(-1)).searchParams.get('token'), 'rotated')
  const generated = h.codes.length
  for (let i = 0; i < 5; i++) h.setup.update({ ...healthy, token: 'rotated' })
  assert.equal(h.codes.length, generated, '状态轮询不反复生成相同二维码')
  h.setup.update({ ...healthy, mode: 'plugin', gatewayRunning: false })
  assert.ok(h.all().filter(el => el.className === 'setup-qr').every(el => el.hidden))
})

test('无 APK 或网络错误时提供重试；恢复后再显示下载入口', async () => {
  for (const options of [{ missing: true }, { fail: true }]) {
    const h = harness(options); h.setup.update(healthy); await flush()
    assert.equal(h.find('a', '下载到当前设备').hidden, true)
    assert.equal(h.find('button', '用手机扫码下载').disabled, true)
    assert.match(h.root.textContent, /未附带可下载的 APK，或请求失败/)
    assert.equal(h.find('button', '重新检查安装包').disabled, false)
  }
  const h = harness({ missing: true }); h.setup.update(healthy); await flush()
  h.available(); await h.find('button', '重新检查安装包').click(); await flush()
  assert.equal(h.find('a', '下载到当前设备').hidden, false)
})

test('管理页在线不算手机成功，真实手机连接才确认；已有用户默认收起', async () => {
  const h = harness()
  h.setup.update({ ...healthy, devices: [{ kind: 'admin', online: true }] }); await flush()
  assert.match(h.root.textContent, /等待手机连接/)
  h.setup.update({ ...healthy, devices: [{ kind: 'app', online: true }] })
  assert.match(h.root.textContent, /已检测到手机或浏览器在线/)
  const existing = harness(); existing.setup.update({ ...healthy, devices: [{ kind: 'web', online: true }] })
  assert.equal(existing.root.children[0].open, false)
})

test('设备密钥模式不发共享令牌码；无可达地址或认证失败时阻止配对', async () => {
  const h = harness(); h.setup.update({ ...healthy, deviceKeys: { enabled: true } }); await flush()
  await h.find('button', '添加设备并配对').click()
  assert.deepEqual(h.calls, ['key']); assert.equal(h.codes.length, 0)
  for (const changes of [{ lanIPs: [] }, { host: '127.0.0.1' }, { gatewayAuthError: 'wrong token' }]) {
    h.setup.update({ ...healthy, ...changes })
    assert.equal(h.find('button', '显示连接二维码').disabled, true)
    assert.equal(h.find('button', '用手机扫码下载').disabled, true)
  }
  await h.find('button', '打开控制台').click()
  assert.equal(h.calls.at(-1), 'console', '认证失败不能变成启动或停止操作')
  h.setup.update({ ...healthy, mode: 'plugin', gatewayRunning: true })
  await h.find('button', '打开控制台').click()
  assert.equal(h.calls.at(-1), 'console', '管理状态不可用时不能误停已运行网关')
})

test('网关停用时仍可下载；只有插件页可启动网关；切换语言保留地址控件', async () => {
  const h = harness(); h.setup.update({ ...healthy, mode: 'plugin', gatewayInstalled: true }); await flush()
  assert.equal(h.find('a', '下载到当前设备').hidden, false)
  await h.find('button', '启动网关').click(); assert.deepEqual(h.calls, ['start'])
  h.window.I18N.lang = 'en'; h.setup.update(healthy)
  assert.ok(h.find('button', 'Show connection QR'))
  assert.match(h.root.textContent, /Package on this host/)
  assert.equal(h.all().filter(el => el.tagName === 'select').length, 1)
  const standalone = harness({ canStart: false }); standalone.setup.update({ mode: 'plugin' }); await flush()
  assert.equal(standalone.find('button', '启动网关'), undefined)
})

test('分步引导保留手动步骤，继续配对不伪造连接结果，离开时清除二维码', async () => {
  const h=harness();h.setup.update(healthy);await flush()
  const steps=h.all().filter(el=>el.tagName==='li')
  assert.deepEqual(steps.map(el=>el.hidden),[true,false,true])
  await h.find('button','我已安装，继续配对').click()
  assert.deepEqual(steps.map(el=>el.hidden),[true,true,false])
  h.setup.update(healthy)
  assert.deepEqual(steps.map(el=>el.hidden),[true,true,false])
  assert.match(h.root.textContent,/等待手机连接/)
  await h.find('button','显示连接二维码').click()
  h.setup.conceal()
  assert.ok(h.all().filter(el=>el.className==='setup-qr').every(el=>el.hidden))
})
