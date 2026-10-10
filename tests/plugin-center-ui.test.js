'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../public/plugin-center.js'), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.events = {}; this.className = ''; this.classList = { toggle() {} } }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child) } }
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
  const c = vm.createContext({ window: {}, document: { body, createElement: tag => new Element(tag) }, AbortSignal, Date, Math,
    setTimeout: handler => { const id = ++timerId; timers.set(id, handler); return id }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => url.endsWith('/state') ? structuredClone(snapshot) : { ok: true } } } })
  vm.runInContext(source, c)
  const config = server => ({ url: route => server + route, headers: {}, valid: () => valid })
  return { body, calls, timers, c, center: c.window.DshPluginCenter, config, snapshot, setValid: value => { valid = value } }
}
const find = (root, label) => root.querySelectorAll('button').find(el => el.textContent === label)
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