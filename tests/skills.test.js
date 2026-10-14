'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const adapter = import('../packages/plugin/skills.mjs')
const raw = () => ({ complete: true, groups: [{ key: 'user-dsh', skills: [{ name: 'code-review', description: '检查代码', path: '/host/private/skills/code-review/SKILL.md', modelInvocable: false, userInvocable: true }] }] })
test('skills adapter maps opaque IDs to fresh scanned paths and exposes read operations only', async () => {
  const { createSkillsAdapter } = await adapter, calls = []; let changed = false
  const center = createSkillsAdapter(async route => {
    calls.push(route)
    if (route.endsWith('/list')) { const data = raw(); if (changed) data.groups[0].skills[0].path += '-moved'; return data }
    const url = new URL(route, 'http://host')
    assert.equal(url.pathname, '/api/dsh-skill-explorer/read'); assert.equal(url.searchParams.get('path'), raw().groups[0].skills[0].path)
    return { name: 'code-review', path: url.searchParams.get('path'), content: '<script>never execute</script>' }
  })
  const result = await center.handle('GET', '/list'), id = result.body.items[0].id
  assert.match(id, /^[a-f0-9]{64}$/); assert.equal(result.body.items[0].modelInvocable, false)
  assert.doesNotMatch(JSON.stringify(result), /\/host\/private|SKILL\.md/)
  const body = await center.handle('GET', '/read', new URLSearchParams({ id }))
  assert.equal(body.body.content, '<script>never execute</script>')
  assert.equal((await center.handle('POST', '/read')).status, 405)
  for (const q of ['path=/etc/passwd', 'id=' + id + '&id=' + id, 'id=' + id + '&cwd=/private']) assert.equal((await center.handle('GET', '/read', new URLSearchParams(q))).status, 400)
  const before = calls.length; changed = true
  assert.equal((await center.handle('GET', '/read', new URLSearchParams({ id }))).status, 409)
  assert.equal(calls.length, before + 1)
})
test('skills failure responses are bounded and never forward upstream errors or configuration', async () => {
  const { createSkillsAdapter } = await adapter
  for (const [status, code] of [[404, 'not-installed'], [403, 'host-denied'], [500, 'skills-unavailable']]) {
    const center = createSkillsAdapter(async () => { throw Object.assign(new Error('SECRET /home/private'), { status }) })
    const result = await center.handle('GET', '/list'); assert.equal(result.body.code, code); assert.doesNotMatch(JSON.stringify(result), /SECRET|private/)
  }
  assert.equal((await createSkillsAdapter(async () => ({ groups: [] })).handle('GET', '/list')).body.code, 'unsupported')
  const center = createSkillsAdapter(async () => ({ complete: false, apiKey: 'SECRET', groups: [{ key: 'runtime', skills: [{ name: 'runtime-skill', description: 'x'.repeat(4000) }] }] }))
  const body = (await center.handle('GET', '/list')).body
  assert.equal(body.complete, false); assert.equal(body.items[0].description.length, 3000); assert.equal(body.items[0].modelInvocable, null)
  assert.equal((await center.handle('GET', '/read', new URLSearchParams({ id: body.items[0].id }))).body.content, null)
  assert.doesNotMatch(JSON.stringify(body), /SECRET/)
})
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.events = {}; this.className = ''; this.value = '' }
  append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child) } }
  remove() { if (this.parentNode) { const parent = this.parentNode; parent.children.splice(parent.children.indexOf(this), 1); this.parentNode = null } }
  prepend(...children) { for(const child of children.reverse()){child.remove();child.parentNode=this;this.children.unshift(child)} }
  before(...children) { const parent=this.parentNode,index=parent.children.indexOf(this);for(const child of children)child.parentNode=parent;parent.children.splice(index,0,...children) }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children) }
  setAttribute(name, value) { this.attributes[name] = value }
  addEventListener(name, fn) { this.events[name] = fn }
  fire(name) { this.events[name]?.() }
  getBoundingClientRect() { return { top: this.top || 0 } }
  focus() {}
  querySelector(selector) { return selector.startsWith('.') ? this.query(selector.slice(1)) : this.all().find(el=>el.tagName.toLowerCase()===selector) }
  query(cls) { return this.all().find(el => el.className.split(' ').includes(cls)) }
  all() { return this.children.flatMap(child => [child, ...child.all()]) }
}
const tick = () => new Promise(r => setImmediate(r))
function setup(fetch, mobile = false, scroller) {
  const context = vm.createContext({ window: { matchMedia: () => ({ matches: mobile }) }, document: { createElement: tag => new Element(tag), createTextNode:text=>{const el=new Element('text');el.textContent=text;return el}, scrollingElement: scroller }, fetch, AbortController, AbortSignal, Date })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/skills.js'), 'utf8'), context)
  return context.window.DshSkillsCenter
}
const items = [{ id: 'a'.repeat(64), name: 'alpha', description: 'Alpha review', source: 'user-dsh', modelInvocable: true, userInvocable: true }, { id: 'b'.repeat(64), name: 'beta', description: 'Beta build', source: 'runtime', modelInvocable: false }]
const list = { ok: true, schema: 1, available: true, complete: true, generatedAt: Date.now(), items }
test('skill UI filters by search/source/status and displays hostile content as text', async () => {
  const center = setup(async url => ({ ok: true, json: async () => url.endsWith('/list') ? list : { ok: true, content: '<script>alert(1)</script>' } })), target = new Element('section')
  await center.mount({ valid: () => true, url: p => p, headers: {} }, target)
  const shell = target.children[0], search = shell.query('sc-filters').children[0], sources = shell.query('sc-filters').children[1], status = shell.query('sc-filters').children[2]
  assert.equal(shell.query('sc-list').children.length, 2)
  search.value = 'Beta'; search.fire('input'); assert.equal(shell.query('sc-list').children.length, 1)
  search.value = ''; search.fire('input'); sources.value = 'runtime'; sources.fire('change'); assert.equal(shell.query('sc-list').children.length, 1)
  sources.value = ''; status.value = 'on'; status.fire('change'); assert.equal(shell.query('sc-list').children.length, 1)
  shell.query('sc-list').children[0].children.at(-1).fire('click'); await tick()
  assert.equal(shell.query('sc-content').textContent, '<script>alert(1)</script>'); assert.equal(shell.query('sc-content').tagName, 'PRE')
  status.value = 'off'; status.fire('change'); assert.equal(shell.query('sc-content'), undefined)
  center.close()
})
test('closing or switching skill centers rejects late detail results and aborts requests', async () => {
  let release, signal
  const center = setup(async (url, options) => {
    if (url.includes('/read')) { signal = options.signal; return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ ok: true, content: 'old server' }) }) }) }
    return { ok: true, json: async () => list }
  })
  const a = new Element('section'), b = new Element('section'), connection = host => ({ valid: () => true, url: p => host + p, headers: {} })
  await center.mount(connection('A'), a); a.query('sc-list').children[0].children.at(-1).fire('click')
  await center.mount(connection('B'), b); assert.equal(signal.aborted, true)
  release(); await tick(); assert.equal(b.query('sc-content'), undefined)
  center.close()
})

test('mobile skill details open inside the clicked card without replacing cards or jumping the viewport', async () => {
  let release
  const scroller = { scrollTop: 900 }
  const center = setup(async url => {
    if (url.includes('/read')) return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ ok: true, content: 'body'.repeat(1000) }) }) })
    return { ok: true, json: async () => list }
  }, true, scroller), target = new Element('section')
  await center.mount({ valid: () => true, url: p => p, headers: {} }, target)
  const cards = [...target.query('sc-list').children], detail = target.query('sc-detail'), action = cards[1].children.at(-1)
  assert.equal(detail.hidden, true)
  action.fire('click')
  assert.equal(detail.parentNode, cards[1]); assert.equal(detail.hidden, false)
  assert.deepEqual(target.query('sc-list').children, cards); assert.equal(scroller.scrollTop, 900)
  release(); await tick()
  assert.equal(scroller.scrollTop, 900); assert.equal(action.textContent, '收起技能')
  action.fire('click'); assert.equal(detail.hidden, true); assert.equal(action.attributes['aria-expanded'], 'false')
  assert.equal(scroller.scrollTop, 900)
  center.close()
})

test('switching mobile skill cards compensates only for the collapsed panel above the clicked action', async () => {
  const scroller = { scrollTop: 1200 }
  const center = setup(async url => ({ ok: true, json: async () => url.endsWith('/list') ? list : { ok: true, content: 'body' } }), true, scroller), target = new Element('section')
  await center.mount({ valid: () => true, url: p => p, headers: {} }, target)
  const cards = target.query('sc-list').children, first = cards[0].children.at(-1), second = cards[1].children.at(-1)
  first.fire('click'); await tick()
  let measurements = 0; second.getBoundingClientRect = () => ({ top: ++measurements === 1 ? 240 : 140 })
  second.fire('click'); await tick()
  assert.equal(scroller.scrollTop, 1100); assert.equal(target.query('sc-detail').parentNode, cards[1])
  center.close()
})

test('dedicated skill reading returns to the exact filtered list and scroll position; late details after back are ignored',async()=>{
 let release
 const scroller={scrollTop:850},center=setup(async url=>url.endsWith('/list')?{ok:true,json:async()=>list}:new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({ok:true,content:'<script>never run</script> alpha'})})}),true,scroller),target=new Element('section')
 await center.mount({valid:()=>true,url:p=>p,headers:{}},target,{dedicated:true})
 const shell=target.children[0],search=shell.query('sc-filters').children[0];search.value='alpha';search.fire('input')
 const cards=[...shell.query('sc-list').children];cards[0].children.at(-1).fire('click');assert.equal(scroller.scrollTop,0);assert.equal(shell.query('sc-body').hidden,true)
 assert.equal(center.back(),true);assert.equal(scroller.scrollTop,850);assert.equal(search.value,'alpha');assert.deepEqual(shell.query('sc-list').children,cards)
 release();await tick();assert.equal(shell.query('sc-content'),undefined)
 cards[0].children.at(-1).fire('click');release();await tick();assert.equal(shell.query('sc-content').textContent,'<script>never run</script> alpha');assert.ok(shell.query('sc-reading-tools'))
 center.back();assert.equal(scroller.scrollTop,850);center.close()
})
