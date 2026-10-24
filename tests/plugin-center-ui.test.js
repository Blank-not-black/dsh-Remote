'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../public/plugin-center.js'), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.events = {}; this.className = ''; this.value = ''; this.classList = { toggle() {} } }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child) } }
  prepend(...children) { for (const child of children) child.parent = this; this.children.unshift(...children) }
  replaceChildren(...children) { this.children = []; this.append(...children) }
  setAttribute(name, value) { this.attributes[name] = value }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler) }
  fire(name) { for (const handler of this.events[name] || []) handler({ preventDefault() {} }) }
  close() { this.open = false; queueMicrotask(() => this.fire('close')) }
  showModal() { this.open = true }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this) }
  scrollIntoView() {}
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  querySelectorAll(selector) {
    const result = []
    const matches = el => selector[0] === '.' ? el.className.split(' ').includes(selector.slice(1))
      : selector === '[data-pc-tab]' ? !!el.dataset.pcTab
      : selector === 'details[open]' ? el.tagName === 'DETAILS' && el.open
      : el.tagName.toLowerCase() === selector
    for (const child of this.children) { if (matches(child)) result.push(child); result.push(...child.querySelectorAll(selector)) }
    return result
  }
}
function setup() {
  const body = new Element('body'), calls = [], timers = new Map()
  let timerId = 0, valid = true
  const snapshot = { ok: true, profile: 'fixture', revision: 'revision', writable: true, busy: false, pendingRestart: false,
    items: [{ name: 'example-plugin', displayName: 'Example', description: 'fixture', version: '1.0.0', managed: true, bundle: true, enabled: true, runtime: [] }, { name: 'core', managed: false, enabled: true }],
    runtime: [], runtimeAvailable: true, operations: [] }
  const c = vm.createContext({ window: {}, document: { body, createElement: tag => new Element(tag) }, AbortSignal, AbortController, URLSearchParams, Date, Math,
    setTimeout: handler => { const id = ++timerId; timers.set(id, handler); return id }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => url.endsWith('/state') ? structuredClone(snapshot) : { ok: true } } } })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/extensions.js'), 'utf8'), c)
  vm.runInContext(source, c)
  const config = server => ({ url: route => server + route, headers: {}, valid: () => valid })
  return { body, calls, timers, c, center: c.window.DshPluginCenter, config, snapshot, setValid: value => { valid = value } }
}
const find = (root, label) => root.querySelectorAll('button').find(el => el.textContent === label)

test('Remote offers update without uninstall or disable on the installed page',async()=>{
 const h=setup(),target=new Element('section');h.snapshot.items.push({name:'dsh-remote-plugin',managed:false,selfUpdate:true,enabled:true,version:'1.0.0'})
 await h.center.mount(h.config('http://A'),target)
 const card=target.children[0].querySelectorAll('article').find(el=>el.dataset.plugin==='dsh-remote-plugin')
 assert.ok(find(card,'更新 Remote'));assert.equal(find(card,'卸载'),undefined);assert.equal(card.querySelectorAll('button').some(b=>b.attributes.role==='switch'),false);h.center.close()
})

test('installed plugin details compare semver and require explicit selection for a downgrade', async () => {
  for (const [installed, available, label, disabled] of [
    ['0.8.0','0.8.0-rc.9','降级至',true], ['0.10.0','0.9.99','降级至',true],
    ['1.0.0','0.10.100','降级至',true], ['0.8.0-rc.10','0.8.0-rc.9','降级至',true],
    ['0.8.0-rc.9','0.8.0-rc.10','更新',false], ['0.8.0-rc.9','0.8.0','更新',false],
    ['0.9.99','0.10.0','更新',false], ['0.10.100','1.0.0','更新',false],
    ['1.0.0-alpha','1.0.0-alpha.1','更新',false], ['1.0.0-2','1.0.0-alpha','更新',false],
    ['0.8.0+local','0.8.0+registry','已安装',true], ['custom-build','0.8.0','切换至',true],
  ]) {
    const h=setup(),target=new Element('section');h.snapshot.items[0].version=installed
    h.c.fetch=async(url,options)=>{h.calls.push({url,options});return{ok:true,json:async()=>url.endsWith('/state')?structuredClone(h.snapshot):{ok:true,item:{name:'example-plugin',version:available,bundle:true,engines:{},peers:{}}}}}
    await h.center.mount(h.config('http://A'),target)
    const card=target.children[0].querySelector('.pc-list').querySelector('article')
    find(card,'查看更新').fire('click');await tick()
    const area=card.querySelector('.pc-inline-detail'), action=find(area,label+' '+available)
    assert.ok(action,installed+' -> '+available);assert.equal(action.disabled,disabled,installed+' -> '+available)
    if(label==='降级至'||label==='切换至'){
      find(area,'查看此版本').fire('click');await tick()
      assert.equal(find(area,label+' '+available).disabled,false,'Explicit version selection may enable an intentional switch')
    }
    assert.equal(h.calls.some(call=>call.options.method==='POST'),false,'Reading details must never start an update')
    h.center.close()
  }
})

test('host experimental plugins stay visible in installed, including disabled entries, without management actions', async () => {
  const h = setup(), target = new Element('section')
  const names = ['@deepseek-ai/dsh-experimental-auto-review', '@deepseek-ai/dsh-experimental-terminal-bundle']
  h.snapshot.items.push(...names.map((name, index) => ({ name, managed: false, bundle: true, enabled: index === 0, version: '0.2.1-rc.2', runtime: [] })))
  await h.center.mount(h.config('http://A'), target)
  const page = target.children[0], cards = () => page.querySelector('.pc-list').querySelectorAll('article')
  let group = page.querySelector('.pc-experimental')
  assert.equal(group.open, false)
  assert.equal(group.querySelector('summary').textContent, '实验性插件（2）')
  group.open = true; group.fire('toggle')
  for (const name of names) {
    const card = cards().find(el => el.dataset.plugin === name)
    assert.ok(card, name + ' must appear on installed')
    assert.ok(card.querySelectorAll('span').some(el => el.textContent === '实验性'))
    assert.ok(find(card, '查看详情'))
    assert.equal(find(card, '卸载'), undefined)
    assert.equal(find(card, '查看更新'), undefined)
    assert.equal(card.querySelectorAll('button').some(el => el.attributes.role === 'switch'), false)
  }
  const status = page.querySelector('.pc-filters').querySelector('select')
  status.value = 'disabled'; status.fire('change')
  assert.deepEqual(cards().map(el => el.dataset.plugin), [names[1]])
  assert.equal(page.querySelector('.pc-experimental').open, true)
  assert.equal(page.querySelector('.pc-experimental').querySelector('summary').textContent, '实验性插件（1）')
  status.value = 'all'; status.fire('change')
  h.snapshot.items.at(-1).version = '0.2.1-rc.3'
  find(page, '刷新').fire('click'); await tick()
  group = page.querySelector('.pc-experimental'); assert.equal(group.open, true)
  group.open = false; group.fire('toggle')
  h.snapshot.items.at(-1).version = '0.2.1-rc.4'
  find(page, '刷新').fire('click'); await tick()
  assert.equal(page.querySelector('.pc-experimental').open, false)
  find(page, '内置插件').fire('click'); await tick()
  assert.deepEqual(cards().map(el => el.dataset.plugin), ['core'])
  assert.equal(h.calls.some(call => call.options.method === 'POST'), false)
  h.center.close()
  await h.center.mount(h.config('http://B'), target)
  assert.equal(target.children[0].querySelector('.pc-experimental').open, false)
  h.center.close()
})

test('only the active installed plugin offers its dedicated page; reading remains available during a job', async () => {
  const h = setup(), target = new Element('section'), opens = [], name = '@linxin666/dsh-client-ui-skill-explorer'
  h.snapshot.items.push({name, enabled:true,managed:true,runtime:[]});h.snapshot.runtime.push({name,phase:'active'})
  h.snapshot.busy=true
  await h.center.mount({...h.config('http://A'),onFeature:id=>opens.push(id)}, target)
  const page = target.children[0]
  assert.equal(find(page,'技能中心'),undefined)
  const read=find(page,'打开技能中心');assert.ok(read);assert.notEqual(read.disabled,true);read.fire('click');await tick();assert.deepEqual(opens,['skills'])
  assert.equal(h.calls.some(call=>call.options.method==='POST'),false)
  h.snapshot.runtimeAvailable=false;find(page,'刷新').fire('click');await tick();assert.equal(find(page,'打开技能中心'),undefined)
  h.snapshot.runtimeAvailable=true;find(page,'刷新').fire('click');await tick();assert.ok(find(page,'打开技能中心'))
  h.snapshot.items.at(-1).enabled=false;find(page,'刷新').fire('click');await tick();assert.equal(find(page,'打开技能中心'),undefined)
  h.center.close()
})
test('installed adapter diagnostics show interface support and only the changed plugin needs restart', async () => {
  const h=setup(),target=new Element('section'),name='dsh-cost-meter'
  h.snapshot.items.push({ name,enabled:true,managed:true,version:'1.9.26',runtime:[] })
  h.snapshot.runtime.push({ name,phase:'active' });h.snapshot.adaptations={cost:{supported:false}}
  await h.center.mount({...h.config('http://A'),onFeature(){}},target)
  const page=target.children[0]
  const diagnostic=()=>page.querySelectorAll('.pc-adaptation')[0]
  assert.match(diagnostic().textContent,/接口不兼容/);assert.equal(find(page,'查看费用与额度'),undefined)
  assert.match(diagnostic().querySelector('a').href,/docs\/wiki\/plugins\.md$/)
  h.snapshot.adaptations.cost.supported=true;h.snapshot.pendingRestart=true;h.snapshot.operations=[{name:'another-plugin',phase:'complete',restartRequired:true}]
  find(page,'刷新').fire('click');await tick();assert.match(diagnostic().textContent,/待读取验证/)
  h.snapshot.operations=[{name,phase:'complete',restartRequired:true}];find(page,'刷新').fire('click');await tick();assert.match(diagnostic().textContent,/待重启/)
  h.center.close()
})

test('returning from a dedicated view retains the plugin filter and pauses polling while away',async()=>{
 const h=setup(),target=new Element('section');await h.center.mount(h.config('http://A'),target)
 const page=target.children[0],query=page.querySelector('.pc-filters').querySelector('input');query.value='Example';query.fire('input')
 h.center.pause();assert.equal(h.timers.size,0);assert.equal(page.open,false)
 await h.center.resume();assert.equal(query.value,'Example');assert.equal(page.querySelector('.pc-list').querySelector('h3').textContent,'Example');assert.equal(h.timers.size,1)
 h.center.close()
})

test('running jobs show stage, elapsed time, quiet output and lock reason without opening history manually', async () => {
  const h = setup(), target = new Element('section')
  h.snapshot.busy = true; h.snapshot.busyReason = '无法确认进程是否退出，已保留锁'
  h.snapshot.profileLock = { message: 'DSH 配置被进程 102 占用' }
  h.snapshot.operations = [{ id: 'job', action: 'update', name: 'example-plugin', phase: 'running', stage: 'cli', startedAt: Date.now() - 45000, lastOutputAt: Date.now() - 35000 }]
  await h.center.mount(h.config('http://A'), target)
  const page = target.children[0], progress = page.querySelector('.pc-progress')
  assert.equal(progress.hidden, false)
  const text = progress.querySelectorAll('p').map(el => el.textContent).join(' ')
  assert.match(text, /执行插件命令.*耗时.*最近输出/); assert.match(text, /暂无新输出/)
  assert.match(text, /无法确认/); assert.match(text, /102/)
  assert.equal(page.querySelector('.pc-history').open, true)
  assert.equal(page.querySelector('.pc-jobs').children[0].open, true)
  assert.equal(page.querySelectorAll('button').find(el => el.attributes.role === 'switch').disabled, true)
  page.querySelector('.pc-history').open = false; page.querySelector('.pc-jobs').children[0].open = false
  h.snapshot.operations[0].log = 'next output'
  find(page, '刷新').fire('click'); await tick()
  assert.equal(page.querySelector('.pc-history').open, false)
  assert.equal(page.querySelector('.pc-jobs').children[0].open, false)
  h.snapshot.operations[0].phase = 'complete'; h.snapshot.operations[0].endedAt = Date.now(); h.snapshot.busy = false; h.snapshot.busyReason = ''; h.snapshot.profileLock = null
  find(page, '刷新').fire('click'); await tick()
  assert.equal(progress.hidden, true)
  assert.equal(page.querySelectorAll('button').find(el => el.attributes.role === 'switch').disabled, false)
  h.center.close()
})

test('accepted operation updates its message to the final result after polling', async () => {
  const h = setup(), target = new Element('section')
  await h.center.mount(h.config('http://A'), target)
  const page = target.children[0]
  page.querySelectorAll('button').find(el => el.attributes.role === 'switch').fire('click'); await tick()
  find(page, '确认停用').fire('click'); await tick()
  const body = JSON.parse(h.calls.find(call => call.options.method === 'POST').options.body)
  h.snapshot.operations = [{ ...body, phase: 'complete', stage: 'complete', startedAt: Date.now(), endedAt: Date.now(), message: '配置已保存；重启后生效。' }]
  find(page, '刷新').fire('click'); await tick()
  assert.match(page.querySelector('.pc-message').textContent, /已完成.*example-plugin.*配置已保存/)
  h.center.close()
})
test('plugin page mounts inline, separates built-ins and filters installed entries', async () => {
  const h = setup(), target = new Element('section')
  await h.center.mount(h.config('http://A'), target)
  const page = target.children[0]
  assert.equal(page.tagName, 'DIV')
  assert.equal(page.querySelector('.pc-list').querySelectorAll('article').length, 1)
  const query = page.querySelector('.pc-filters').querySelector('input'); query.value = 'absent'; query.fire('input')
  assert.equal(page.querySelector('.pc-list').querySelectorAll('article').length, 0)
  query.value = ''; query.fire('input')
  find(page, '内置插件').fire('click'); await tick()
  assert.equal(page.querySelector('.pc-list').querySelector('h3').textContent, 'core')
  h.center.close(); assert.equal(target.children.length, 0); assert.equal(h.timers.size, 0)
})
test('closing a dialog cannot invalidate the next mounted page through a delayed close event', async () => {
  const h = setup(), target = new Element('section')
  await h.center.open(h.config('http://A'))
  await h.center.mount(h.config('http://B'), target); await tick()
  const page = target.children[0]
  assert.equal(page.querySelector('.pc-profile').textContent, '当前环境：fixture')
  assert.equal(h.timers.size, 1)
  find(page, '刷新').fire('click'); await tick()
  assert.equal(h.calls.at(-1).url, 'http://B/remote/api/plugins/state')
})
test('an old queued button action cannot arm a mutation on a newly mounted connection', async () => {
  const h = setup(), target = new Element('section')
  await h.center.mount(h.config('http://A'), target)
  const oldSwitch = target.children[0].querySelectorAll('button').find(el => el.attributes.role === 'switch')
  oldSwitch.fire('click')
  await h.center.mount(h.config('http://B'), target); await tick()
  assert.equal(target.children[0].querySelector('.pc-detail').children.length, 0)
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0)
})
test('confirmation sends one operation and stops after connection invalidation', async () => {
  const h = setup(), target = new Element('section')
  await h.center.mount(h.config('http://A'), target)
  const page = target.children[0], toggle = page.querySelectorAll('button').find(el => el.attributes.role === 'switch')
  toggle.fire('click'); await tick()
  find(page, '确认停用').fire('click'); await tick()
  const writes = h.calls.filter(call => call.options.method === 'POST')
  assert.equal(writes.length, 1)
  assert.equal(JSON.parse(writes[0].options.body).name, 'example-plugin')
  toggle.fire('click'); await tick(); h.setValid(false)
  find(page, '确认停用').fire('click'); await tick()
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1)
})

test('release approval lists exact blockers and cannot submit until the consent checkbox is selected', async () => {
  const h = setup(), target = new Element('section')
  const plan = { key: 'review-key', minutes: 1440, blockers: [{ name: 'dsh-remote-plugin', version: '0.8.0-rc.4', publishedAt: '2026-10-18T11:57:57Z', eligibleAt: '2026-10-19T11:57:57Z' }], ruleChanges: ['dsh-remote-plugin@0.7.6 || 0.8.0-rc.4'] }
  h.c.fetch = async (url, options) => { h.calls.push({ url, options }); return { ok: true, json: async () => url.endsWith('/state') ? structuredClone(h.snapshot) : url.endsWith('/preflight') ? { ok: true, plan } : { ok: true } } }
  await h.center.mount(h.config('http://A'), target)
  const page = target.children[0]
  find(page, '卸载').fire('click'); await tick()
  const review = page.querySelector('.pc-detail'), confirm = find(review, '确认卸载'), checkbox = review.querySelector('input')
  assert.equal(confirm.disabled, true)
  assert.equal(h.calls.some(call => call.url.endsWith('/operations')), false)
  assert.ok(review.querySelectorAll('p').some(el => el.textContent.includes('dsh-remote-plugin@0.8.0-rc.4')))
  checkbox.checked = true; checkbox.fire('change'); assert.equal(confirm.disabled, false)
  confirm.fire('click'); await tick()
  const write = h.calls.find(call => call.url.endsWith('/operations')), body = JSON.parse(write.options.body)
  assert.equal(body.preflightKey, plan.key); assert.equal(body.confirmReleasePolicy, true)
  assert.equal(h.calls.filter(call => call.url.endsWith('/operations')).length, 1)
  h.center.close()
})

test('cancelling a release review writes no operation and late preflight cannot cross a connection switch', async () => {
  const h = setup(), target = new Element('section'); let resolve
  h.c.fetch = async (url, options) => {
    h.calls.push({ url, options })
    if (url.endsWith('/preflight')) return new Promise(done => { resolve = done })
    return { ok: true, json: async () => structuredClone(h.snapshot) }
  }
  await h.center.mount(h.config('http://A'), target)
  find(target.children[0], '卸载').fire('click'); await tick()
  await h.center.mount(h.config('http://B'), target)
  resolve({ ok: true, json: async () => ({ ok: true, plan: { key: 'old-review', blockers: [], ruleChanges: [] } }) }); await tick()
  assert.equal(target.children[0].querySelector('.pc-detail').children.length, 0)
  assert.equal(h.calls.some(call => call.url.endsWith('/operations')), false)
  h.center.close()
})

test('failed jobs offer an explicit restoration review bound to the source job and current profile', async () => {
  const h = setup(), target = new Element('section')
  h.snapshot.operations = [{ id: 'failed-original', name: 'example-plugin', action: 'update', version: '2.0.0', phase: 'failed', stage: 'cli', startedAt: Date.now(), endedAt: Date.now(), canRestore: true }]
  await h.center.mount(h.config('http://A'), target)
  const page = target.children[0]
  find(page, '恢复更新前状态').fire('click'); await tick()
  assert.equal(h.calls.some(call => call.url.endsWith('/operations')), false)
  find(page.querySelector('.pc-detail'), '确认恢复').fire('click'); await tick()
  const body = JSON.parse(h.calls.find(call => call.url.endsWith('/operations')).options.body)
  assert.equal(body.action, 'restore'); assert.equal(body.restoreFrom, 'failed-original'); assert.equal(body.revision, 'revision'); assert.equal(body.confirmRestore, true)
  h.center.close()
})

test('plugin details expand on their own card and remain expanded after status refresh', async () => {
  const h=setup(),target=new Element('section')
  h.snapshot.items.push({name:'second-plugin',displayName:'Second',managed:true,enabled:true,runtime:[]})
  await h.center.mount(h.config('http://A'),target)
  const page=target.children[0],card=page.querySelector('.pc-list').querySelectorAll('article')[1]
  find(card,'查看详情').fire('click');await tick()
  assert.equal(card.querySelector('.pc-inline-detail').hidden,false)
  assert.equal(find(card,'收起详情').attributes['aria-expanded'],'true')
  assert.equal(page.querySelector('.pc-detail').children.length,0)
  h.snapshot.items[2].runtime=[{name:'component',phase:'active'}]
  find(page,'刷新').fire('click');await tick()
  const next=page.querySelector('.pc-list').querySelectorAll('article')[1]
  assert.equal(next.querySelector('.pc-inline-detail').hidden,false)
  assert.ok(next.querySelector('.pc-inline-detail').querySelectorAll('p').some(p=>p.textContent==='component · 运行中'))
  find(next,'收起详情').fire('click');await tick()
  assert.equal(next.querySelector('.pc-inline-detail').hidden,true)
  h.center.close()
})

test('market detail errors stay inside the clicked card and retry can recover',async()=>{
  const h=setup(),target=new Element('section');await h.center.mount(h.config('http://A'),target)
  let failed=true
  h.c.fetch=async()=>{if(failed)throw new Error('fixture network failed');return{ok:true,json:async()=>({item:{name:'example-plugin',version:'2.0.0',bundle:true,engines:{},peers:{}}})}}
  const card=target.children[0].querySelector('.pc-list').querySelector('article')
  find(card,'查看更新').fire('click');await tick()
  assert.equal(card.querySelector('.pc-detail-error').textContent,'fixture network failed')
  failed=false;find(card,'重试').fire('click');await tick()
  assert.equal(card.querySelector('.pc-inline-detail').querySelector('h4').textContent,'example-plugin @ 2.0.0')
  h.center.close()
})

test('discovery keeps adapted plugins visible for unavailable, empty, failing and ready official indexes without mutations', async () => {
  for (const state of [{ available: false, code: 'not-installed', indexes: [] }, { available: true, indexes: [] }, { available: true, indexes: [{ url: 'https://catalog.example/', title: '目录' }] }, { available: true, indexes: [{ url: 'https://catalog.example/', code: 'index-unavailable' }] }]) {
    const h = setup(), target = new Element('section')
    h.c.fetch = async (url, options) => { h.calls.push({ url, options }); return { ok: true, json: async () => url.endsWith('/state') ? structuredClone(h.snapshot) : url.endsWith('/market/indexes') ? state : { ok: true, available: true, index: { title: '目录' }, categories: [], items: [], total: 0, nextOffset: null, fetchedAt: 123 } } }
    await h.center.mount(h.config('http://A'), target)
    const page = target.children[0]; find(page, '添加插件').fire('click'); await tick(); await tick()
    assert.equal(page.querySelector('.pc-adapted').querySelector('h3').textContent, 'Remote 已适配')
    assert.equal(page.querySelector('.pc-adapted').querySelectorAll('article').length, 5)
    assert.equal(h.calls.some(call => call.options.method === 'POST'), false)
    assert.equal(h.calls.some(call => call.url.includes('/-/v1/search')), false)
    if (!state.available || !state.indexes.length || state.indexes[0]?.code) assert.equal(h.calls.some(call => call.url.includes('/market?')), false)
    h.center.close()
  }
})

test('adapted install uses the verified exact version through preflight and never latest', async () => {
  const h = setup(), target = new Element('section')
  h.c.fetch = async (url, options) => { h.calls.push({ url, options }); return { ok: true, json: async () => url.endsWith('/state') ? structuredClone(h.snapshot) : url.endsWith('/market/indexes') ? { available: false, indexes: [] } : { ok: true, plan: { key: 'review', blockers: [], ruleChanges: [] } } } }
  await h.center.mount(h.config('http://A'), target); const page = target.children[0]
  find(page, '添加插件').fire('click'); await tick()
  find(page, '安装已核验版本 1.8.17').fire('click'); await tick()
  const review = h.calls.find(call => call.url.endsWith('/preflight'))
  assert.equal(JSON.parse(review.options.body).version, '1.8.17'); assert.equal(h.calls.some(call => call.url.endsWith('/operations')), false)
  h.center.close()
})

test('official pages retain fetchedAt and late discovery responses cannot cross a connection switch', async () => {
  const h = setup(), target = new Element('section'); let resolve
  h.c.fetch = async (url, options) => {
    h.calls.push({ url, options })
    if (url.includes('/market?') && url.includes('offset=20')) return new Promise(done => { resolve = done })
    return { ok: true, json: async () => url.endsWith('/state') ? structuredClone(h.snapshot) : url.endsWith('/market/indexes') ? { available: true, indexes: [{ url: 'https://catalog.example/' }] } : { ok: true, available: true, index: { title: '目录' }, categories: [], items: [], total: 21, nextOffset: 20, fetchedAt: 123 } }
  }
  await h.center.mount(h.config('http://A'), target); find(target.children[0], '添加插件').fire('click'); await tick(); await tick()
  find(target.children[0], '下一页').fire('click'); await tick(); await tick()
  assert.ok(h.calls.some(call => call.url.includes('offset=20') && call.url.includes('fetchedAt=123')))
  await h.center.mount(h.config('http://B'), target)
  resolve({ ok: true, json: async () => ({ ok: true, available: true, items: [{ name: 'old-host' }], total: 1, nextOffset: null }) }); await tick()
  assert.equal(target.children[0].querySelector('.pc-adapted'), null); assert.equal(target.children[0].querySelector('.pc-list').querySelector('h3').textContent, 'Example')
  h.center.close()
})

test('full package-name details remain available without official indexes and README uses strict image options', async () => {
  const h = setup(), target = new Element('section'); let options
  h.c.window.mdToHtml = (text, value) => { options = value; return '<p>README</p>' }
  h.c.fetch = async (url, init) => { h.calls.push({ url, options: init }); return { ok: true, json: async () => url.endsWith('/state') ? structuredClone(h.snapshot) : url.includes('/readme?') ? { ok: true, available: true, content: '# Example', version: '2.0.0' } : { ok: true, item: { name: 'example-plugin', version: '2.0.0', bundle: true, engines: {}, peers: {} } } } }
  await h.center.mount(h.config('http://A'), target)
  const page = target.children[0], input = page.querySelector('.pc-search'); input.value = 'example-plugin'
  find(page, '按包名查看').fire('click'); await tick()
  assert.equal(page.querySelector('.pc-detail').querySelector('h4').textContent, 'example-plugin @ 2.0.0')
  find(page.querySelector('.pc-detail'), '阅读 README').fire('click'); await tick()
  assert.equal(options.richContent, false); assert.equal(options.fileLinks, false); assert.ok(options.imageHosts.includes('img.shields.io'))
  h.center.close()
})
