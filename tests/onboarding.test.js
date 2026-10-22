'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.attrs = {}; this.hidden = false; this.value = ''
    this.className = ''; this._text = ''
    const classes = () => new Set(this.className.split(/\s+/).filter(Boolean))
    this.classList = {
      contains: value => classes().has(value),
      add: value => { const list = classes(); list.add(value); this.className = [...list].join(' ') },
      remove: value => { const list = classes(); list.delete(value); this.className = [...list].join(' ') },
      toggle: (value, enabled) => { if (enabled ?? !classes().has(value)) this.classList.add(value); else this.classList.remove(value) },
    }
  }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this); this.parentElement = null }
  append(...items) { for (const item of items) { item.remove(); item.parentElement = this; this.children.push(item) } }
  prepend(...items) { for (const item of [...items].reverse()) { item.remove(); item.parentElement = this; this.children.unshift(item) } }
  replaceChildren(...items) { for (const item of [...this.children]) item.remove(); this._text = ''; this.append(...items) }
  set textContent(value) { this.replaceChildren(); this._text = value }
  get textContent() { return this._text + this.children.map(item => item.textContent).join('') }
  setAttribute(key, value) { this.attrs[key] = value }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
  click() { if (!this.disabled) return Promise.all((this.listeners.click || []).map(fn => fn())) }
  all() { return this.children.flatMap(child => [child, ...child.all()]) }
  querySelector(selector) { return this.all().find(item => selector.startsWith('.') ? item.classList.contains(selector.slice(1)) : item.tagName === selector) }
  getClientRects() { return this.hidden ? [] : [{ width: 100 }] }
  scrollIntoView() {} focus() { this.focused = true }
}
function harness({ stored, failStorage = false } = {}) {
  const body = new Element('body'), home = new Element('section'), settings = new Element('section'), session = new Element('section')
  const preferences = new Element('div'), about = new Element('button')
  preferences.id = 'workflow-more-preferences'; preferences.append(about); settings.append(preferences)
  home.id = 'view-home'; settings.id = 'settings-home'; session.id = 'view-session'; body.append(home, settings, session)
  const storage = new Map(stored ? [['dshRemoteOnboardingV1', stored]] : [])
  const calls = [], live = { connected: false, connection: 1, session: null, sessionReady: false }
  let current = home, modal = null, draft = ''
  const targets = new Map()
  for (const key of ['#workflow-connection', '#btn-new-session', '#composer-input', '#history', '#fs-upload-btn', '#home-doctor', '#fb-msg']) targets.set(key, new Element('button'))
  const document = {
    body, getElementById: id => [body, ...body.all()].find(item => item.id === id), createElement: tag => new Element(tag),
    addEventListener() {}, querySelector: selector => selector.startsWith('.modal:not') ? modal : selector === '#main > .view:not(.hidden)' ? current : targets.get(selector),
  }
  const window = { I18N: { lang: 'zh' }, localStorage: {
    getItem(key) { if (failStorage) throw Error('denied'); return storage.get(key) },
    setItem(key, value) { if (failStorage) throw Error('quota'); storage.set(key, value) },
  } }
  vm.runInNewContext(fs.readFileSync('public/onboarding.js', 'utf8'), { window, document, queueMicrotask,
    fetch: () => assert.fail('the guide must not submit network requests') })
  const actions = Object.fromEntries(['connect', 'session', 'message', 'results', 'files', 'branch', 'doctor', 'feedback'].map(id => [id, () => calls.push(id)]))
  window.DshOnboarding.mount({ snapshot: () => live, actions, closePractice: () => { modal = null; calls.push('close') },
    example: value => { calls.push('example'); if (draft) return false; draft = value; return true } })
  const guide = window.DshOnboarding, card = document.getElementById('onboarding-coach'), entry = document.getElementById('onboarding-entry')
  const find = text => card.all().find(item => item.tagName === 'button' && item.textContent === text)
  const next = () => card.all().find(item => item.dataset.onboardingAction === 'next')
  return { window, document, guide, card, entry, calls, storage, live, targets, home, session, preferences, about, find, next,
    step: () => JSON.parse(storage.get('dshRemoteOnboardingV1') || '{"step":0}').step,
    setModal: value => { modal = value; guide.update() }, setDraft: value => { draft = value }, draft: () => draft,
    setCurrent: value => { current = value; guide.update() },
    async skipTo(index) { while (this.step() < index) await find('先跳过这步').click() },
  }
}

test('first visit offers an inline invitation; only explicit practice invokes actions', async () => {
  const h = harness()
  assert.equal(h.card.hidden, true); assert.match(h.entry.textContent, /第一次用/); assert.deepEqual(h.calls, [])
  await h.entry.click()
  assert.equal(h.card.hidden, false); assert.match(h.card.textContent, /1\/8/)
  assert.equal(h.next().disabled, true)
  await h.next().click(); assert.equal(h.step(), 0)
  await h.find('打开主机与连接').click(); assert.deepEqual(h.calls, ['connect'])
  h.live.connected = true; h.guide.update()
  assert.equal(h.next().disabled, false)
  await h.next().click(); assert.equal(h.step(), 1)
  assert.ok(!h.calls.includes('session'), 'advancing does not create a conversation')
})

test('More keeps the guide as the final preference row and updates its copy without losing replay', async () => {
  const h = harness()
  const replay = h.document.getElementById('onboarding-restart')
  assert.equal(replay.parentElement, h.preferences)
  assert.deepEqual(h.preferences.children, [h.about, replay])
  assert.ok(replay.classList.contains('workflow-setting-link'))
  assert.equal(replay.querySelector('.setting-name').textContent, '新手引导')
  assert.equal(replay.querySelector('.onboarding-restart-icon').attrs['aria-hidden'], 'true')
  h.guide.start(); await h.skipTo(7); await h.next().click()
  assert.match(replay.querySelector('.setting-desc').textContent, /重新查看/)
  h.window.I18N.lang = 'en'; h.guide.update()
  assert.equal(replay.querySelector('.setting-name').textContent, 'Getting started')
  await replay.click(); assert.equal(h.step(), 0); assert.equal(h.card.hidden, false)
})

test('opening a conversation requires loaded history; only confirmed current message completes sending', async () => {
  const h = harness(); h.guide.start(); h.live.connected = true; h.guide.update(); await h.next().click()
  h.live.session = 'one'; h.guide.update(); assert.equal(h.next().disabled, true)
  h.live.sessionReady = true; h.guide.update(); await h.next().click(); assert.equal(h.step(), 2)
  for (const [type, context] of [
    ['message-pending', { connection: 1, session: 'one' }],
    ['message-accepted', { connection: 0, session: 'one' }],
    ['message-accepted', { connection: 1, session: 'other' }],
  ]) { h.guide.record(type, context); assert.equal(h.next().disabled, true) }
  h.guide.record('message-accepted', { connection: 1, session: 'one' }); assert.equal(h.next().disabled, false)
  // A fast identity change must not allow Next before the scheduled update runs.
  h.live.connection = 2; await h.next().click(); assert.match(h.card.textContent, /3\/8/)
  h.guide.update(); assert.equal(h.next().disabled, true)
  h.live.connected = false; h.guide.record('message-accepted', { connection: 2, session: 'one' }); assert.equal(h.next().disabled, true)
  h.live.connected = true; h.guide.record('message-accepted', { connection: 2, session: 'one' })
  await h.next().click(); assert.equal(h.step(), 3)
  assert.match(h.card.textContent, /不代表模型已经回复/)
})

test('reload after a confirmed first message resumes at results instead of asking for a duplicate send', async () => {
  const h = harness(); h.guide.start(); h.live.connected = true; h.live.session = 'one'; await h.skipTo(2)
  h.guide.record('message-accepted', { connection: 1, session: 'one' })
  const resumed = harness({ stored: h.storage.get('dshRemoteOnboardingV1') })
  await resumed.entry.click(); assert.match(resumed.card.textContent, /4\/8/); assert.deepEqual(resumed.calls, [])
  h.guide.pause(); assert.match(h.entry.textContent, /4\/8/)
})

test('sample is an explicit draft action and never replaces an existing draft or sends it', async () => {
  const h = harness(); h.guide.start(); h.live.connected = true; h.live.session = 'one'; await h.skipTo(2)
  await h.find('把示例放入空白输入框').click(); assert.match(h.draft(), /一句话/)
  assert.equal(h.next().disabled, true)
  h.setDraft('我的原始草稿'); await h.find('把示例放入空白输入框').click()
  assert.equal(h.draft(), '我的原始草稿'); assert.match(h.card.textContent, /保留你的草稿/)
  assert.ok(!h.calls.includes('message'))
})

test('pause and reload resume at the saved step without forced navigation or sensitive persistence', async () => {
  const h = harness(); h.guide.start(); await h.skipTo(5); h.guide.pause()
  assert.equal(h.card.hidden, true); assert.match(h.entry.textContent, /继续新手引导.*6\/8/)
  const raw = h.storage.get('dshRemoteOnboardingV1')
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['schema', 'status', 'step'])
  const resumed = harness({ stored: raw }); assert.equal(resumed.card.hidden, true); assert.deepEqual(resumed.calls, [])
  await resumed.entry.click(); assert.match(resumed.card.textContent, /6\/8/)
  assert.deepEqual(resumed.calls, [])
})

test('coach can collapse without pausing and expands automatically for the next lesson', async () => {
  const h = harness(); h.guide.start()
  await h.find('收起').click(); assert.equal(h.card.classList.contains('is-folded'), true)
  assert.equal(h.find('展开').attrs['aria-expanded'], 'false')
  h.live.connected = true; h.guide.update(); assert.equal(h.card.classList.contains('is-folded'), true)
  await h.find('展开').click(); assert.equal(h.card.classList.contains('is-folded'), false)
  await h.next().click(); assert.equal(h.card.classList.contains('is-folded'), false)
})

test('skipping and finishing never starts diagnosis, creates branches, uploads or submits feedback', async () => {
  const h = harness(); h.guide.start(); await h.skipTo(7)
  assert.match(h.card.textContent, /不必为了完成引导提交测试反馈/)
  await h.next().click()
  assert.equal(h.card.hidden, true); assert.equal(h.entry.hidden, true)
  assert.ok(h.calls.every(value => value === 'close'))
  const resumed = harness({ stored: h.storage.get('dshRemoteOnboardingV1') })
  assert.equal(resumed.entry.hidden, true); assert.equal(resumed.card.hidden, true)
  const replay = resumed.document.getElementById('onboarding-restart')
  assert.equal(replay.hidden, false); await replay.click()
  assert.equal(resumed.step(), 0); assert.equal(resumed.card.hidden, false)
  assert.deepEqual(resumed.calls, [])
})

test('skipping the whole guide hides the home invitation across reloads and leaves replay in More', async () => {
  const h = harness(); h.guide.start(); await h.skipTo(2)
  await h.find('定位输入框').click()
  assert.equal(h.targets.get('#composer-input').classList.contains('onboarding-target'), true)
  await h.find('跳过整个引导，以后在“更多”中查看').click()
  assert.equal(h.card.hidden, true); assert.equal(h.entry.hidden, true)
  assert.equal(h.targets.get('#composer-input').classList.contains('onboarding-target'), false)
  assert.equal(JSON.parse(h.storage.get('dshRemoteOnboardingV1')).status, 'skipped')
  const resumed = harness({ stored: h.storage.get('dshRemoteOnboardingV1') })
  assert.equal(resumed.entry.hidden, true); assert.equal(resumed.card.hidden, true)
  assert.deepEqual(resumed.calls, [])
  await resumed.document.getElementById('onboarding-restart').click()
  assert.match(resumed.card.textContent, /1\/8/)
  assert.equal(resumed.entry.hidden, true)
})

test('unrelated notices and approvals take precedence; expected practice form holds the coach', async () => {
  const h = harness(); h.guide.start()
  const notice = new Element('div'); notice.id = 'modal-announcement'
  h.setModal(notice); assert.equal(h.card.hidden, true)
  h.setModal(null); assert.equal(h.card.hidden, false)
  await h.skipTo(1)
  const modal = new Element('div'), content = new Element('div'); modal.id = 'modal-new-session'; content.className = 'modal-card'; modal.append(content)
  h.setModal(modal); assert.equal(h.card.parentElement, content); assert.equal(h.card.hidden, false)
  await h.skipTo(7)
  modal.id = 'modal-feedback'; h.setModal(modal)
  assert.equal(h.card.parentElement, content); assert.equal(h.card.hidden, false)
  const body = new Element('div'); body.className = 'modal-body'; content.append(body)
  h.guide.update(); assert.equal(h.card.parentElement, body, 'keep the form title and submit actions outside the scrolling tutorial')
})

test('unavailable branch is explained, language switches and unavailable storage do not break the guide', async () => {
  const h = harness(); h.guide.start(); await h.skipTo(5)
  await h.find('回到会话查看分支入口').click(); assert.match(h.card.textContent, /没有可用的分支按钮/)
  h.window.I18N.lang = 'en'; h.guide.update(); assert.match(h.card.textContent, /Try another direction/)
  for (const options of [{ stored: '{bad' }, { stored: '{"schema":1,"step":999,"status":"new"}' }, { failStorage: true }]) {
    const invalid = harness(options); invalid.guide.start(); assert.match(invalid.card.textContent, /1\/8/)
    invalid.guide.pause(); assert.equal(invalid.card.hidden, true)
  }
})

test('mobile adapter preserves drafts and invokes existing UI without sending any request', () => {
  const source = fs.readFileSync('public/app.js', 'utf8')
  const begin = source.indexOf('function mountOnboarding()'), end = source.indexOf('\nasync function clearWorkflowData', begin)
  assert.ok(begin > 0 && end > begin)
  let options, feedback, sent = 0
  const input = { value: 'existing draft', dispatchEvent() {}, focus() {} }
  const context = { window: { DshOnboarding: { mount: value => { options = value } } },
    state: { current: 'one' }, $: id => { assert.equal(id, 'composer-input'); return input },
    openDoctor() {}, showView() {}, newSession() {}, openFeedbackModal: value => { feedback = value },
    sendMessage() { sent++ }, Event, closeNewSessionModal() {}, closeFeedbackModal() {},
  }
  vm.runInNewContext(source.slice(begin, end) + '\nmountOnboarding()', context)
  assert.equal(options.example('new text'), false); assert.equal(input.value, 'existing draft')
  input.value = ''; assert.equal(options.example('new text'), true); assert.equal(input.value, 'new text'); assert.equal(sent, 0)
  options.actions.feedback(); assert.equal(feedback.preserveDraft, true)
})

test('real send controller only notifies onboarding after acceptance and a broken guide cannot reject that send', async () => {
  const source = fs.readFileSync('public/app.js', 'utf8')
  const begin = source.indexOf('async function sendSessionContent('), end = source.indexOf('\nasync function encodeComposerImagesFor', begin)
  for (const scenario of ['accepted', 'unconfirmed', 'rejected', 'slash', 'broken-guide']) {
    const calls = []
    const context = {
      state: { current: 'one', byId: new Map(), pendingPrompts: new Set(), sessionActivity: new Set() },
      connectionGeneration: 7, composerSending: false, composerSendFeedback: new Map(),
      composerContext: () => 'one', $: () => ({ disabled: false }),
      window: { DshOnboarding: { record: (...args) => { if (scenario === 'broken-guide') throw Error('optional UI failure'); calls.push(args) } } },
      renderComposerSend() {}, setSessionRecovery() {}, noteSessionTurnTime() {}, renderSessions() {}, toast() {}, t: key => key,
      runSlashCommand: async () => scenario === 'slash', encodeComposerImagesFor: async () => [],
      safeRpc: async () => scenario === 'unconfirmed' ? null : { accepted: scenario !== 'rejected' },
    }
    vm.runInNewContext(source.slice(begin, end), context)
    const success = await context.sendSessionContent(scenario === 'slash' ? '/help' : 'hello', [])
    assert.equal(success, ['accepted', 'slash', 'broken-guide'].includes(scenario), scenario)
    assert.equal(calls.length, scenario === 'accepted' ? 1 : 0, scenario)
    if (calls.length) { assert.equal(calls[0][0], 'message-accepted'); assert.equal(calls[0][1].session, 'one'); assert.equal(calls[0][1].connection, 7) }
  }
})
