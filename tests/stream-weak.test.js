'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path')
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8')

function fixture(historyPath) {
  const listeners = {}
  const box = {
    scrollTop: 600, scrollHeight: 1000, clientHeight: 400,
    children: [],
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn) },
    querySelectorAll() { return [] },
    getBoundingClientRect() { return { top: 0, bottom: this.clientHeight } },
    prepend() {}, append() {}, insertBefore() {}, replaceChildren() {},
  }
  const element = tag => ({
    tagName: tag, className: '', textContent: '', hidden: false, disabled: false,
    dataset: {}, children: [], addEventListener() {}, querySelectorAll: () => [],
    append() {}, prepend() {}, remove() {},
  })
  const options = { html: () => '', older: () => {}, olderLabel: () => 'older', loadingLabel: () => 'loading', live: () => '', changed() {}, scrolled() {} }
  const c = vm.createContext({ document: { createElement: element, createTextNode: value => ({ textContent: value }) }, JSON, Math, Date, Number, Array, Map, Set, WeakMap, Object, String, Infinity, console })
  vm.runInContext(read(historyPath), c)
  const view = new c.DshHistory.HistoryView(box, options)
  view.render = () => {}
  return { view, box, listeners }
}

test('at bottom follows again even when a drag or momentum left reading set', () => {
  const { view, box } = fixture('public/history.js')
  box.scrollTop = 200
  assert.equal(view.atBottom, false)
  view.reading = true
  box.scrollTop = 600
  assert.equal(view.atBottom, true)
  view.lastScrollTop = 200
  view.onScroll()
  assert.equal(view.reading, false)
})

test('scrolling up keeps newer streamed content pending until the user returns', () => {
  const { view, box } = fixture('public/history.js')
  const entries = [{ seq: 1, event: { type: 'user/message' }, view: {} }, { seq: 2, event: { type: 'assistant/message' }, view: {} }]
  view.set(entries, { reset: true, live: 'first' })
  assert.equal(view.liveHtml, 'first')
  box.scrollTop = 100
  view.intentUntil = Date.now() + 1200
  view.lastScrollTop = 200
  view.onScroll()
  assert.equal(view.reading, true)
  view.set(entries, { live: 'second' })
  assert.equal(view.liveHtml, 'first')
  assert.equal(view.hasPending, true)
  // Reaching the bottom without any wheel/touch intent still resyncs the live block.
  box.scrollTop = 600
  view.onScroll()
  assert.equal(view.reading, false)
  assert.equal(view.liveHtml, 'second')
  assert.equal(view.hasPending, false)
})

test('a stale reading flag is dropped on the next data update when the box is already at the bottom', () => {
  const { view, box } = fixture('public/history.js')
  box.scrollTop = 600
  view.set([{ seq: 1, event: { type: 'user/message' }, view: {} }], { reset: true, live: '' })
  view.reading = true
  view.set([{ seq: 1, event: { type: 'user/message' }, view: {} }, { seq: 2, event: { type: 'assistant/message' }, view: {} }], { live: 'stream' })
  assert.equal(view.reading, false)
  assert.equal(view.liveHtml, 'stream')
})

test('an active upward gesture is never cleared by a stream update at the bottom', () => {
  const { view, box } = fixture('public/history.js')
  box.scrollTop = 600
  view.set([{ seq: 1, event: { type: 'user/message' }, view: {} }], { reset: true, live: '' })
  view.reading = true
  view.intentUntil = Date.now() + 1200
  view.set([{ seq: 1, event: { type: 'user/message' }, view: {} }, { seq: 2, event: { type: 'assistant/message' }, view: {} }], { live: 'stream' })
  assert.equal(view.reading, true, 'scrolling up from the bottom must survive stream updates')
  assert.equal(view.liveHtml, '', 'live content stays frozen while reading')
  view.intentUntil = 0
  view.reading = true
  view.end = view.entries.length
  view.set([{ seq: 1, event: { type: 'user/message' }, view: {} }, { seq: 2, event: { type: 'assistant/message' }, view: {} }, { seq: 3, event: { type: 'assistant/message' }, view: {} }], { live: 'stream2' })
  assert.equal(view.reading, false, 'a stale flag is cleaned up once the gesture is over')
})

test('a plain tap no longer pauses following; only an upward drag does', () => {
  const { view, box, listeners } = fixture('public/history.js')
  view.reading = false
  for (const handler of listeners.pointerdown || []) handler({})
  assert.equal(view.reading, false)
  box.scrollTop = 300
  view.intentUntil = Date.now() + 1200
  view.lastScrollTop = 600
  view.onScroll()
  assert.equal(view.reading, true)
})

test('weak-network stream trim only applies on the weak profile and can be switched off', () => {
  const values = new Map()
  const root = { navigator: { connection: { effectiveType: '4g', downlink: 10, rtt: 20 } }, localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) } }
  const c = vm.createContext({ globalThis: root, module: { exports: {} }, AbortController, setTimeout, clearTimeout })
  vm.runInContext(read('public/network.js'), c)
  const api = c.module.exports
  assert.equal(api.streamTrimmed(), false)
  api.setMode('weak')
  assert.equal(api.streamTrimmed(), true)
  values.set('dshWeakStreamOff', '0')
  assert.equal(api.streamTrimmed(), false)
  values.set('dshWeakStreamOff', '1')
  api.setMode('normal')
  assert.equal(api.streamTrimmed(), false)
})

test('both shells hide live reasoning and unfinished calls when trimming, and the jump button follows real scroll position', () => {
  const app = read('public/app.js'), desktop = read('public/desktop/desktop.js')
  for (const source of [app, desktop]) {
    assert.match(source, /function weakStreamTrim\(\) \{ return !!window\.DshNetwork\?\.streamTrimmed\?\.\(\) \}/)
    assert.match(source, /if \(weakStreamTrim\(\)\) return ''/)
    assert.match(source, /if\(weakStreamTrim\(\)\)prepared=prepared\.filter\(entry=>entry\.event\?\.type!=='tool\/call'\|\|entry\.view\?\.toolActivity\)/)
    assert.match(source, /window\.applyStreamPreference=\(\)=>\{if\(state\.current\)renderHistory\(false,'auto'\)\}/)
    assert.match(source, /toggle\('hidden',view\.atBottom&&view\.unread===0&&!state\.history\.tailEvicted\)/)
  }
  const history = read('public/history.js')
  assert.match(history, /get atBottom\(\)/)
  assert.match(history, /if\(atBottom\)this\.reading=false/)
  assert.match(history, /if\(this\.reading&&Date\.now\(\)>\(this\.intentUntil\|\|0\)&&this\.atBottom&&this\.end>=this\.entries\.length\)this\.reading=false/)
  const network = read('public/network.js')
  assert.match(network, /const STREAM_KEY='dshWeakStreamOff'/)
  assert.match(network, /network-stream-preferences/)
  assert.match(network, /root\.applyStreamPreference\?\.\(\)/)
  assert.match(read('public/workflow.js'), /'dshWeakStreamOff'/)
})
