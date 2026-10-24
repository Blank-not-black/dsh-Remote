'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { task, snapshot } = require('./fixtures/task-board-data.cjs')
const backend = import('../packages/plugin/task-board.mjs'), ui = require('../public/task-board.js')
const workspace = { id: 'workspace-fixture', sessionIds: ['insights-session'] }
test('task board projects only registered workspace tasks and whitelisted execution, schedule and verification fields', async () => {
  const { summarizeTaskBoard } = await backend, data = summarizeTaskBoard(snapshot,workspace)
  assert.equal(data.tasks.length,1); assert.equal(data.tasks[0].executions[0].sessionId,'insights-session')
  assert.equal(data.tasks[0].schedule.timeZone,'Asia/Shanghai'); assert.equal(data.tasks[0].executions[0].verification.passed,false)
  assert.doesNotMatch(JSON.stringify(data),/SECRET|prompt|handover|findings|其他工作区|未绑定任务|隐藏任务/)
  const moved = structuredClone(snapshot); moved.tasks[0].executions[0].sessionId = 'foreign-session'
  assert.equal(summarizeTaskBoard(moved,workspace).tasks[0].executions[0].sessionId,'')
  moved.tasks = Array.from({ length: 201 },(_,i) => ({ ...task,id:'task-'+i }))
  assert.equal(summarizeTaskBoard(moved,workspace).tasks.length,200); assert.equal(summarizeTaskBoard(moved,workspace).truncated,true)
  moved.tasks.push({...task,id:'active-task',status:'running',updatedAt:1})
  assert.equal(summarizeTaskBoard(moved,workspace).tasks[0].id,'active-task','Active tasks must not be lost behind old archived rows')
})
test('task board bridge validates scope before reading and never invokes mutating service methods', async () => {
  const { readTaskBoard } = await backend; let reads = 0
  const ctx = { get: name => name === 'workspaceRegistry' ? { list: () => [workspace] } : name === 'taskBoard' ? { snapshot() { reads++; return snapshot }, apply() { assert.fail('Read must not apply actions') } } : undefined }
  for (const query of ['', 'workspaceId=missing','workspaceId=workspace-fixture&path=/private','workspaceId=workspace-fixture&workspaceId=other','workspaceId=workspace-fixture&action=run']) assert.ok((await readTaskBoard(ctx,new URLSearchParams(query))).status>=400)
  assert.equal(reads,0)
  const result = await readTaskBoard(ctx,new URLSearchParams('workspaceId=workspace-fixture')); assert.equal(result.status,200); assert.equal(result.body.tasks.length,1); assert.equal(reads,1)
  const withService = service => ({ get: key => key === 'workspaceRegistry' ? { list: () => [workspace] } : key === 'taskBoard' ? service : undefined })
  const q = new URLSearchParams('workspaceId=workspace-fixture')
  assert.equal((await readTaskBoard(withService(null),q)).body.code,'not-installed')
  assert.equal((await readTaskBoard(withService({}),q)).body.code,'unsupported')
  assert.equal((await readTaskBoard(withService({ snapshot: () => ({...snapshot,schemaVersion:7}) }),q)).body.code,'unsupported')
  assert.equal((await readTaskBoard(withService({ snapshot() { throw Error('SECRET') } }),q)).body.code,'task-board-unavailable')
  assert.equal((await readTaskBoard(withService({ snapshot: () => new Promise(() => {}) }),q,10)).body.code,'timeout')
})
test('task cards distinguish board columns, execution outcomes and verification, and render content as text', async () => {
  const { summarizeTaskBoard } = await backend, safe = summarizeTaskBoard(snapshot,workspace).tasks[0]
  const html = ui.taskHtml(safe,0,'Asia/Shanghai')
  assert.match(html,/验收未通过/); assert.match(html,/打开执行会话/); assert.match(html,/Asia\/Shanghai/); assert.doesNotMatch(html,/验收记录通过/)
  const hostile = { ...safe,title:'<img src=x onerror=bad>',description:'<script>bad</script>',status:'done',executions:[{...safe.executions[0],result:null,verification:{ applicability:'enforced',stage:'invalid',passed:true }}] }
  assert.match(ui.taskHtml(hostile,0),/尚无有效验收通过记录/); assert.doesNotMatch(ui.taskHtml(hostile,0),/<img|<script>|验收记录通过/)
  assert.doesNotMatch(ui.taskHtml({...safe,executions:[{...safe.executions[0],sessionId:'',external:true}]},0),/data-task-open/)
  const repeated = ui.taskHtml({...safe,description:'第一行\n第二行',executions:[{...safe.executions[0],error:'同一失败原因',verification:{failedReason:'同一失败原因'}}]},0)
  assert.equal(repeated.match(/同一失败原因/g).length,1,'Repeated execution and verification errors should be shown once')
  assert.match(repeated,/class="ext-copy task-description">第一行\n第二行<\/p>/,'Authored content keeps intentional line breaks')
})
test('task workspace switches and close abort reads; late results cannot replace another workspace', async () => {
  const pending = [], reports = [], opened = []
  class Element {
    constructor() { this.listeners = {}; this.children = new Map(); this.innerHTML = '' }
    querySelector(key) { if (!this.children.has(key)) this.children.set(key,new Element()); return this.children.get(key) }
    querySelectorAll() { return [] }
    addEventListener(key,fn) { this.listeners[key] = fn }
    replaceChildren() { this.innerHTML = '' }
  }
  const target = new Element(), root = { DshExtensions: { reportAvailability: (...args) => reports.push(args) } }
  const c = vm.createContext({ window: root,document:{hidden:false},AbortController,AbortSignal,
    fetch:(url,options) => new Promise(resolve => pending.push({url,options,resolve})),setInterval:()=>1,clearInterval(){} })
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/task-board.js'),'utf8'),c)
  const config = { valid:()=>true,url:p=>p,headers:{},getWorkspaces:()=>[{workspaceId:'a'},{workspaceId:'b'}],openTaskSession:async (...args) => opened.push(args) }
  const first = root.DshTasks.mount(config,target), selector = target.querySelector('[data-task-workspace]')
  selector.value='b';selector.listeners.change();assert.equal(pending[0].options.signal.aborted,true)
  const reply = (index,workspaceId,title) => pending[index].resolve({ok:true,text:async()=>JSON.stringify({ok:true,schema:1,available:true,source:'task-board',workspaceId,generatedAt:Date.now(),tasks:[{...task,title,executions:[{sessionId:'allowed'}]}]})})
  reply(1,'b','Workspace B');await new Promise(r=>setImmediate(r));reply(0,'a','Workspace A');await first
  assert.match(target.querySelector('[data-task-content]').innerHTML,/Workspace B/);assert.doesNotMatch(target.querySelector('[data-task-content]').innerHTML,/Workspace A/)
  assert.equal(reports.length,1)
  await target.querySelector('[data-task-content]').listeners.click({target:{closest:()=>({dataset:{taskOpen:'0'}})}})
  assert.deepEqual(opened,[['allowed','b']])
  target.querySelector('[data-task-refresh]').listeners.click()
  pending[2].resolve({ok:true,text:async()=>JSON.stringify({ok:true,schema:1,available:false})})
  await new Promise(r=>setImmediate(r));assert.equal(target.querySelector('[data-task-content]').innerHTML,'')
  target.querySelector('[data-task-refresh]').listeners.click();reply(3,'b','Workspace B')
  await new Promise(r=>setImmediate(r));assert.match(target.querySelector('[data-task-content]').innerHTML,/Workspace B/,'Same data must reappear after service recovery')
  target.querySelector('[data-task-refresh]').listeners.click();root.DshTasks.close();assert.equal(pending[4].options.signal.aborted,true)
  reply(4,'b','Late content');await new Promise(r=>setImmediate(r));assert.equal(reports.length,3)
})
test('mobile and desktop task-session callbacks keep the selected host and registered workspace', async () => {
  for (const desktop of [false,true]) {
    const file = path.join(__dirname,desktop ? '../public/desktop/desktop.js' : '../public/app.js'), source=fs.readFileSync(file,'utf8')
    const start=source.indexOf(desktop?'function openDesktopPlugins(':'function openPluginPage('), end=source.indexOf(desktop?'\nfunction showView(':'\n// Operation logs',start)
    const state={workspaces:[{workspaceId:'w'}],current:'',byId:new Map(),view:'view-plugins'};let config,opened,valid=true,visible=true
    const c=vm.createContext({state,window:{DshExtensions:{mount:value=>{config=value}}},$:()=>({classList:{contains:()=>!visible}}),
      captureConnection:()=>({token:'test-only',valid:()=>valid}),workspaceItems:()=>state.workspaces,
      clientIdHeaders:()=>({}),CAP:null,openSession:async id=>{opened=id}})
    vm.runInContext(source.slice(start,end),c)
    if(desktop)c.openDesktopPlugins();else c.openPluginPage()
    await config.openTaskSession('allowed','w');assert.equal(opened,'allowed')
    await assert.rejects(config.openTaskSession('bad','unregistered'),/unavailable/)
    opened=null;valid=false;await config.openTaskSession('bad','w');assert.equal(opened,null)
    valid=true;visible=false;state.view='view-home';await config.openTaskSession('bad','w');assert.equal(opened,null)
  }
})
