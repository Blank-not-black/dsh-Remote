'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const doctor = require(path.join(ROOT, 'public', 'doctor.js'))
const tick = () => new Promise(resolve => setImmediate(resolve))

function doctorPrompt(overrides = {}) {
  return doctor.buildDoctorPrompt({
    lang: 'zh',
    symptom: '手机端历史记录偶尔停在加载中',
    environment: {
      surface: 'Android app',
      appVersion: '0.8.0-rc.6',
      gatewayVersion: '0.8.0-rc.6',
      gatewayOk: true,
      dshVersion: '0.2.1-rc.1',
      host: '测试主机',
      token: 'must-not-appear',
      cookie: 'must-not-appear',
    },
    diagnostics: () => ({ schema: 1, events: [{ kind: 'history.load', phase: 'failed', category: 'timeout' }] }),
    includeDiagnostics: true,
    ...overrides,
  })
}

test('doctor prompt is explicitly read-only, bounded, and asks for an issue-ready draft', () => {
  const prompt = doctorPrompt()
  assert.match(prompt, /^\/dsh-remote-doctor\n/)
  assert.match(prompt, /只读边界/)
  assert.match(prompt, /不提交反馈、不创建 Issue/)
  assert.match(prompt, /最多看最后约 120 行/)
  assert.match(prompt, /反馈草稿/)
  assert.match(prompt, /手机端历史记录偶尔停在加载中/)
  assert.match(prompt, /history\.load/)
  assert.doesNotMatch(prompt, /must-not-appear/)
  assert.doesNotMatch(prompt, /token:/)
})

test('doctor prompt omits local diagnostics until the user opts in', () => {
  const prompt = doctorPrompt({ includeDiagnostics: false })
  assert.doesNotMatch(prompt, /history\.load/)
  assert.match(prompt, /Android app/)
})

test('feedback draft contains the sections maintainers need and stays under the issue URL cap', () => {
  const draft = doctor.buildFeedbackDraft({
    lang: 'zh',
    symptom: '升级后无法连接',
    environment: { surface: 'Desktop web', appVersion: '0.8.0-rc.6', token: 'private' },
    diagnostics: () => 'x'.repeat(9000),
    includeDiagnostics: true,
  })
  assert.match(draft, /## 问题现象/)
  assert.match(draft, /## 复现步骤/)
  assert.match(draft, /## 环境/)
  assert.match(draft, /## AI 诊断结论/)
  assert.doesNotMatch(draft, /private/)
  const url = doctor.buildIssueUrl({ title: doctor.feedbackTitle({ symptom: '升级后无法连接' }), body: draft })
  assert.match(url, /^https:\/\/github\.com\/Blank-not-black\/dsh-Remote\/issues\/new\?/)
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.get('title'), '[Bug] 升级后无法连接')
  assert.ok(parsed.searchParams.get('body').length <= 5600)
  assert.ok(url.length <= 7900, `issue URL too long: ${url.length}`)
})

test('desktop and mobile entries wire the doctor panel and ship its assets', () => {
  const mobileHtml = read('public/index.html')
  const desktopHtml = read('public/desktop/desktop.html')
  for (const html of [mobileHtml, desktopHtml]) {
    assert.match(html, /id="btn-doctor"/)
    assert.match(html, /doctor\.css/)
    assert.match(html, /doctor\.js/)
  }
  assert.match(read('public/app.js'), /btn-doctor.*addEventListener\('click', openDoctor\)/)
  assert.match(mobileHtml, /id="view-home"[\s\S]*?id="home-doctor"/)
  assert.match(read('public/app.js'), /home-doctor.*addEventListener\('click', openDoctor\)/)
  assert.match(read('public/desktop/desktop.js'), /btn-doctor.*addEventListener\('click', openDoctor\)/)
  assert.match(read('scripts/sync-plugin.mjs'), /doctor\.js', 'doctor\.css'/)
  assert.match(read('packages/plugin/package.json'), /doctor-skill\.mjs/)
  assert.match(read('scripts/sync-standalone.mjs'), /doctor-skill\.mjs/)
  assert.match(read('packages/plugin/skills/dsh-remote-doctor/SKILL.md'), /name: dsh-remote-doctor/)
})

test('doctor skill registration degrades to a prompt-only fallback on older hosts', async () => {
  const module = await import(pathToFileURL(path.join(ROOT, 'packages/plugin/doctor-skill.mjs')).href)
  assert.equal(module.registerDoctorSkill({ effect() {} }), false)
  const guardedContext = new Proxy({ effect() {} }, {
    get(target,key) { if(key === 'skills') throw new Error('undeclared service'); return target[key] }
  })
  assert.equal(module.registerDoctorSkill(guardedContext), false, 'optional service getter cannot block plugin startup')
  const providers = []
  const ctx = {
    effect(factory) { const dispose = factory(); assert.equal(typeof dispose, 'function'); return dispose },
    skills: { registerProvider(create) { providers.push(create({ signal: new AbortController().signal, invalidate() {} })); return () => {} } },
  }
  assert.equal(module.registerDoctorSkill(ctx), true)
  assert.equal(providers.length, 1)
  const [candidate] = await providers[0].list({})
  assert.equal(candidate.name, 'dsh-remote-doctor')
  assert.equal(candidate.invocation.modelInvocable, true)
  const skill = await providers[0].get(candidate, {})
  assert.match(skill.content, /Read-only by default/)
  assert.doesNotMatch(skill.content, /^---/)
})

test('doctor registers through declared optional injection, including a registry arriving after plugin apply',async()=>{
  const module=await import(pathToFileURL(path.join(ROOT,'packages/plugin/doctor-skill.mjs')).href)
  let activate;const providers=[],disposers=[]
  const ctx={inject(names,callback){assert.deepEqual(names,['skills']);activate=callback}}
  assert.equal(module.registerDoctorSkill(ctx),true);assert.equal(module.doctorSkillStatus(ctx),'waiting')
  const service={registerProvider(create){providers.push(create({}));return()=>providers.pop()}}
  const child={get:name=>name==='skills'?service:undefined,effect(factory){const dispose=factory();if(dispose)disposers.push(dispose)}}
  activate(child);assert.equal(module.doctorSkillStatus(ctx),'registered');assert.equal(providers.length,1)
  for(const dispose of disposers.reverse())dispose()
  assert.equal(providers.length,0);assert.equal(module.doctorSkillStatus(ctx),'waiting')
})

test('diagnosis target comes from the loaded module and exposes only bounded workspace metadata',async()=>{
  const {readDoctorTarget,DOCTOR_PLUGIN_ROOT}=await import(pathToFileURL(path.join(ROOT,'packages/plugin/doctor-target.mjs')).href)
  const result=readDoctorTarget({get:()=>({list:()=>[{id:'repo',title:'Source',path:'/fixture/source',token:'SECRET'}]})})
  assert.equal(result.plugin.path,DOCTOR_PLUGIN_ROOT);assert.equal(result.plugin.kind,'loaded-plugin')
  assert.equal(result.plugin.version,JSON.parse(read('packages/plugin/package.json')).version)
  assert.deepEqual(result.workspaces,[{workspaceId:'repo',title:'Source',path:'/fixture/source'}])
  assert.doesNotMatch(JSON.stringify(result),/SECRET/)
})

test('workspace targets wait for declared optional service and clear on disposal',async()=>{
  const {watchDoctorWorkspaces,readDoctorTarget}=await import(pathToFileURL(path.join(ROOT,'packages/plugin/doctor-target.mjs')).href)
  let activate,dispose
  const ctx={inject(names,callback){assert.deepEqual(names,['workspaceRegistry']);activate=callback},get(){throw Error('undeclared')}}
  watchDoctorWorkspaces(ctx);assert.deepEqual(readDoctorTarget(ctx).workspaces,[])
  activate({get:()=>({list:()=>[{id:'repo',path:'/fixture/repo'}]}),effect(factory){dispose=factory()}})
  assert.equal(readDoctorTarget(ctx).workspaces[0].workspaceId,'repo')
  dispose();assert.deepEqual(readDoctorTarget(ctx).workspaces,[])
})

/* Minimal browser stand-in for the self-contained doctor panel. */
class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.attributes = {}
    this.dataset = {}
    this.events = {}
    this.style = {}
    this._className = ''
    this._text = ''
    this.value = ''
    this.checked = false
    this.disabled = false
    this.parent = null
  }
  get className() { return this._className }
  set className(value) { this._className = String(value || '') }
  get classList() {
    const self = this
    return {
      add(...names) { self._className = [...new Set([...self._className.split(/\s+/).filter(Boolean), ...names])].join(' ') },
      remove(...names) { const drop = new Set(names); self._className = self._className.split(/\s+/).filter(name => name && !drop.has(name)).join(' ') },
      contains(name) { return self._className.split(/\s+/).includes(name) },
      toggle(name, force) {
        const on = force === undefined ? !this.contains(name) : !!force
        on ? this.add(name) : this.remove(name)
        return on
      },
    }
  }
  get textContent() { return this.children.length ? this.children.map(child => child.textContent || '').join('') : this._text }
  set textContent(value) { this._text = String(value == null ? '' : value); this.children = [] }
  append(...nodes) { for (const node of nodes) { if (node && typeof node === 'object') node.parent = this; this.children.push(node) } }
  prepend(...nodes) { for (const node of nodes) { if (node && typeof node === 'object') node.parent = this; this.children.unshift(node) } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes) }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return this.attributes[name] }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler) }
  fire(name, event = {}) { for (const handler of this.events[name] || []) handler({ target: this, preventDefault() {}, ...event }) }
  click() { this.fire('click') }
  focus() { this.ownerDocument.activeElement = this }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this) }
}
function makeDocument() {
  const created = []
  const document = {
    body: null,
    activeElement: null,
    events: {},
    createElement(tag) { const node = new Element(tag); node.ownerDocument = document; created.push(node); return node },
    createTextNode(text) { return { nodeType: 3, textContent: String(text) } },
    addEventListener(name, handler) { (document.events[name] ||= []).push(handler) },
  }
  document.body = document.createElement('body')
  document.activeElement = document.body
  return { document, created }
}
function all(rootNode) {
  const out = []
  for (const child of rootNode.children || []) {
    if (child && child.tagName) { out.push(child); out.push(...all(child)) }
  }
  return out
}
function findButton(document, label) { return all(document.body).find(node => node.tagName === 'BUTTON' && node.textContent === label) }

function setupDoctorPanel(options = {}) {
  const { document } = makeDocument()
  const sandbox = { document, URLSearchParams, setTimeout, clearTimeout, I18N: { lang: 'zh' } }
  sandbox.window = sandbox
  vm.runInNewContext(read('public/doctor.js'), sandbox)
  const panel = sandbox.DshDoctor
  panel.open({ connection: { valid: () => true }, ...options })
  const nodes = all(document.body)
  const symptom = nodes.find(node => node.tagName === 'TEXTAREA')
  return {
    panel, document, symptom,
    include: nodes.find(node => node.tagName === 'INPUT'),
    overlay: nodes.find(node => node.className.includes('doctor-overlay')),
    status: nodes.find(node => node.className === 'doctor-status'),
    button: label => findButton(document, label),
    fill(text) { symptom.value = text; symptom.fire('input') },
  }
}

const targetFixture={ok:true,schema:1,plugin:{path:'/fixture/installed/dsh-remote-plugin',version:'0.8.0-rc.8',kind:'loaded-plugin'},skill:{status:'registered'},workspaces:[{workspaceId:'source',title:'Source',path:'/fixture/source'}]}
test('opening the panel only reads the target; starting defaults to the installed directory without attaching a workspace',async()=>{
  const calls=[]
  const view=setupDoctorPanel({loadTarget:async()=>targetFixture,workspaceId:'previous-workspace',rpc:async(method,payload)=>{calls.push({method,payload});return method==='session.create'?{sessionId:'diagnosis'}:{accepted:true}},openSession:async()=>{}})
  assert.equal(calls.length,0);view.fill('Cannot connect');assert.equal(view.button('开始只读诊断').disabled,true)
  await tick();assert.equal(calls.length,0)
  const select=all(view.document.body).find(n=>n.tagName==='SELECT')
  assert.equal(select.value,'plugin');assert.match(all(view.document.body).find(n=>n.className.includes('doctor-target-path')).textContent,/installed/)
  view.button('开始只读诊断').click();await tick()
  assert.equal(calls[0].payload.cwd,targetFixture.plugin.path);assert.equal(calls[0].payload.workspaceId,undefined)
  assert.match(calls[1].payload.content[0].text,/本会话从实际加载的插件目录启动/)
  assert.doesNotMatch(calls[1].payload.content[0].text,/\/fixture\/installed/)
})
test('selecting a source workspace changes only creation location while preserving the installation comparison instructions',async()=>{
  const calls=[],view=setupDoctorPanel({loadTarget:async()=>targetFixture,rpc:async(method,payload)=>{calls.push({method,payload});return method==='session.create'?{sessionId:'diagnosis'}:{accepted:true}},openSession:async()=>{}})
  await tick();const select=all(view.document.body).find(n=>n.tagName==='SELECT');select.value='0';select.fire('change');view.fill('UI issue')
  view.button('开始只读诊断').click();await tick()
  assert.equal(calls[0].payload.workspaceId,'source');assert.equal(calls[0].payload.cwd,undefined)
  assert.match(calls[1].payload.content[0].text,/另行确认运行插件的位置/)
})
test('target read failure never silently diagnoses the previous workspace',async()=>{
  const view=setupDoctorPanel({loadTarget:async()=>{throw Error('offline')},rpc:async()=>assert.fail('unexpected request')})
  view.fill('Problem');await tick();assert.equal(view.button('开始只读诊断').disabled,true)
  assert.match(view.status.textContent,/无法定位/)
})

test('copy diagnostics button writes the report and confirms the result', async () => {
  const copied = []
  const report = { schema: 1, events: [{ kind: 'history.load', phase: 'failed' }] }
  const view = setupDoctorPanel({
    diagnostics: () => report,
    copy: async text => { copied.push(text); return true },
  })
  view.button('复制诊断').click()
  await tick()
  assert.equal(copied.length, 1)
  assert.deepEqual(JSON.parse(copied[0]), report)
  assert.equal(view.status.dataset.kind, 'ok')
})

test('cancelling pending session creation ignores both success and failure', async t => {
  for (const outcome of ['resolve', 'reject']) {
    await t.test(outcome, async () => {
      let settle
      const calls = [], opened = [], copied = [], notices = []
      const view = setupDoctorPanel({
        rpc: (method, payload) => {
          calls.push({ method, payload })
          return new Promise((resolve, reject) => { settle = outcome === 'resolve' ? resolve : reject })
        },
        openSession: async id => { opened.push(id) },
        copy: async text => { copied.push(text); return true },
        toast: text => notices.push(text),
      })
      view.fill('取消这次诊断')
      view.button('开始只读诊断').click()
      view.button('取消').click()
      settle(outcome === 'resolve' ? { sessionId: 'cancelled' } : new Error('late failure'))
      await tick()
      assert.deepEqual(calls.map(call => call.method), ['session.create'])
      assert.deepEqual(opened, [])
      assert.deepEqual(copied, [])
      assert.deepEqual(notices, [])
      assert.equal(view.overlay.getAttribute('aria-hidden'), 'true')
    })
  }
})

test('reopening the panel isolates a new start from a cancelled creation', async () => {
  const pending = [], calls = [], opened = []
  const options = {
    connection: { valid: () => true },
    rpc: (method, payload) => {
      calls.push({ method, payload })
      if (method === 'session.create') return new Promise(resolve => pending.push(resolve))
      return Promise.resolve({ accepted: true })
    },
    openSession: async id => { opened.push(id) },
  }
  const view = setupDoctorPanel(options)
  view.fill('第一次现象')
  view.button('开始只读诊断').click()
  view.button('取消').click()
  view.panel.open(options)
  view.fill('重新打开后的现象')
  view.button('开始只读诊断').click()
  pending[0]({ sessionId: 'old-session' })
  await tick()
  assert.deepEqual(calls.map(call => call.method), ['session.create', 'session.create'])
  assert.equal(view.overlay.getAttribute('aria-hidden'), 'false')
  assert.equal(view.symptom.disabled, true)
  pending[1]({ sessionId: 'new-session' })
  await tick()
  assert.equal(calls[2].method, 'session.prompt')
  assert.equal(calls[2].payload.sessionId, 'new-session')
  assert.match(calls[2].payload.content[0].text, /重新打开后的现象/)
  assert.doesNotMatch(calls[2].payload.content[0].text, /第一次现象/)
  assert.deepEqual(opened, ['new-session'])
})

test('diagnosis sends the symptom, environment and logs captured at start', async () => {
  let completeCreate, version = 'approved-build', phase = 'approved-phase'
  const calls = []
  const view = setupDoctorPanel({
    rpc: (method, payload) => {
      calls.push({ method, payload })
      if (method === 'session.create') return new Promise(resolve => { completeCreate = resolve })
      return Promise.resolve({ accepted: true })
    },
    environment: () => ({ appVersion: version }),
    diagnostics: () => ({ schema: 1, events: [{ phase }] }),
    openSession: async () => {},
  })
  view.fill('已确认发送的现象')
  view.include.checked = true
  view.button('开始只读诊断').click()
  version = 'later-build'
  phase = 'later-phase'
  view.symptom.value = '未确认发送的现象'
  completeCreate({ sessionId: 'snapshot-session' })
  await tick()
  const prompt = calls[1].payload.content[0].text
  assert.match(prompt, /已确认发送的现象/)
  assert.match(prompt, /approved-build/)
  assert.match(prompt, /approved-phase/)
  assert.doesNotMatch(prompt, /later-build|later-phase|未确认发送的现象/)
})

test('a cancelled pending prompt failure does not copy or navigate', async () => {
  let rejectPrompt
  const copied = [], opened = [], notices = []
  const view = setupDoctorPanel({
    rpc: method => method === 'session.create'
      ? Promise.resolve({ sessionId: 'already-created' })
      : new Promise((resolve, reject) => { rejectPrompt = reject }),
    copy: async text => { copied.push(text); return true },
    openSession: async id => { opened.push(id) },
    toast: text => notices.push(text),
  })
  view.fill('发送中取消')
  view.button('开始只读诊断').click()
  await tick()
  view.button('取消').click()
  rejectPrompt(new Error('late prompt rejection'))
  await tick()
  assert.deepEqual(copied, [])
  assert.deepEqual(opened, [])
  assert.deepEqual(notices, [])
})

test('switching connections during creation prevents sending and shows disconnection', async () => {
  let completeCreate, valid = true
  const calls = []
  const view = setupDoctorPanel({
    connection: { valid: () => valid },
    rpc: method => {
      calls.push(method)
      return new Promise(resolve => { completeCreate = resolve })
    },
  })
  view.fill('等待连接检查')
  view.button('开始只读诊断').click()
  valid = false
  completeCreate({ sessionId: 'old-connection-session' })
  await tick()
  assert.deepEqual(calls, ['session.create'])
  assert.match(view.status.textContent, /当前未连接 DSH/)
  assert.equal(view.button('开始只读诊断').disabled, true)
})

test('a late fallback copy cannot close a reopened panel or navigate away', async () => {
  let completeCopy
  const opened = [], notices = []
  const view = setupDoctorPanel({
    rpc: async method => {
      if (method === 'session.create') return { sessionId: 'failed-send' }
      throw new Error('prompt rejected')
    },
    copy: () => new Promise(resolve => { completeCopy = resolve }),
    openSession: async id => { opened.push(id) },
    toast: text => notices.push(text),
  })
  view.fill('发送失败')
  view.button('开始只读诊断').click()
  await tick()
  assert.equal(typeof completeCopy, 'function')
  view.button('取消').click()
  view.panel.open({ connection: { valid: () => true }, rpc: async () => {} })
  view.fill('新的现象')
  completeCopy(true)
  await tick()
  assert.equal(view.overlay.getAttribute('aria-hidden'), 'false')
  assert.equal(view.symptom.value, '新的现象')
  assert.deepEqual(opened, [])
  assert.deepEqual(notices, [])
})

test('session creation errors remain visible and allow a successful retry', async () => {
  let attempts = 0
  const opened = []
  const view = setupDoctorPanel({
    rpc: async method => {
      if (method === 'session.create') {
        if (++attempts === 1) throw new Error('connection refused (test)')
        return { sessionId: 'retry-session' }
      }
      return { accepted: true }
    },
    openSession: async id => { opened.push(id) },
  })
  view.fill('诊断启动失败')
  view.button('开始只读诊断').click()
  await tick()
  assert.match(view.status.textContent, /connection refused \(test\)/)
  assert.equal(view.status.dataset.kind, 'err')
  assert.equal(view.button('开始只读诊断').disabled, false)
  assert.equal(view.symptom.disabled, false)
  view.button('开始只读诊断').click()
  await tick()
  assert.deepEqual(opened, ['retry-session'])
})

test('starting diagnosis creates a separate session and sends the doctor prompt', async () => {
  const { document } = makeDocument()
  const sandbox = {
    window: null, document, URLSearchParams, setTimeout, clearTimeout,
    I18N: { lang: 'zh' }, navigator: { clipboard: { writeText: async () => {} } },
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(read('public/doctor.js'), sandbox)
  const panel = sandbox.window.DshDoctor
  const calls = [], opened = [], statuses = []
  panel.open({
    connection: { valid: () => true },
    rpc: async (method, payload) => {
      calls.push({ method, payload })
      if (method === 'session.create') return { sessionId: 'diagnostic-session' }
      if (method === 'session.prompt') return { accepted: true }
      throw new Error('unexpected method')
    },
    openSession: async id => { opened.push(id) },
    workspaceId: () => 'workspace-1',
    environment: () => ({ surface: 'Android app', appVersion: '0.8.0-rc.6' }),
    diagnostics: () => ({ schema: 1, events: [] }),
    copy: async () => true,
    toast: (message, kind) => statuses.push({ message, kind }),
  })
  const textarea = all(document.body).find(node => node.tagName === 'TEXTAREA')
  const start = findButton(document, '开始只读诊断')
  assert.ok(textarea)
  assert.ok(start)
  assert.equal(start.disabled, true)
  textarea.value = '连接后历史记录不显示'
  textarea.fire('input')
  start.click()
  for (let index = 0; index < 12 && opened.length === 0; index += 1) await tick()
  assert.equal(calls[0].method, 'session.create')
  assert.equal(calls[0].payload.workspaceId, 'workspace-1')
  assert.equal(calls[1].method, 'session.prompt')
  assert.equal(calls[1].payload.sessionId, 'diagnostic-session')
  assert.equal(calls[1].payload.mode, 'queue')
  assert.equal(calls[1].payload.content[0].type, 'text')
  assert.match(calls[1].payload.content[0].text, /^\/dsh-remote-doctor/)
  assert.match(calls[1].payload.content[0].text, /连接后历史记录不显示/)
  assert.deepEqual(opened, ['diagnostic-session'])
  assert.equal(statuses.at(-1).kind, 'ok')
})

test('a rejected prompt opens the new session and copies the prompt for manual sending', async () => {
  const { document } = makeDocument()
  const sandbox = {
    window: null, document, URLSearchParams, setTimeout, clearTimeout,
    I18N: { lang: 'zh' }, navigator: { clipboard: { writeText: async () => {} } },
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(read('public/doctor.js'), sandbox)
  const copied = [], opened = [], notices = []
  sandbox.window.DshDoctor.open({
    connection: { valid: () => true },
    rpc: async method => {
      if (method === 'session.create') return { sessionId: 'half-started' }
      throw new Error('prompt rejected by host')
    },
    openSession: async id => { opened.push(id) },
    workspaceId: () => 'workspace-1',
    environment: () => ({ surface: 'Desktop web' }),
    diagnostics: () => ({ schema: 1, events: [] }),
    copy: async text => { copied.push(text); return true },
    toast: (message, kind) => notices.push({ message, kind }),
  })
  const textarea = all(document.body).find(node => node.tagName === 'TEXTAREA')
  textarea.value = '发送后没有回复'
  textarea.fire('input')
  findButton(document, '开始只读诊断').click()
  for (let index = 0; index < 12 && opened.length === 0; index += 1) await tick()
  assert.deepEqual(opened, ['half-started'])
  assert.equal(copied.length, 1)
  assert.match(copied[0], /^\/dsh-remote-doctor/)
  assert.match(notices.at(-1).message, /提示词已复制/)
  assert.equal(notices.at(-1).kind, 'err')
})

test('unreachable host keeps the fallback panel usable and disables starting', () => {
  const { document } = makeDocument()
  const sandbox = {
    window: null, document, URLSearchParams, setTimeout, clearTimeout,
    I18N: { lang: 'zh' }, navigator: { clipboard: { writeText: async () => {} } },
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(read('public/doctor.js'), sandbox)
  sandbox.window.DshDoctor.open({
    connection: { valid: () => false },
    rpc: async () => { throw new Error('must not run') },
    environment: () => ({ host: 'offline' }),
    diagnostics: () => ({ schema: 1, events: [] }),
    copy: async () => true,
  })
  const start = findButton(document, '开始只读诊断')
  assert.equal(start.disabled, true)
  assert.match(all(document.body).find(node => node.className.includes('doctor-status')).textContent, /当前未连接 DSH/)
  assert.ok(findButton(document, '复制排查提示词'))
  assert.ok(findButton(document, '打开 GitHub Issue'))
})
