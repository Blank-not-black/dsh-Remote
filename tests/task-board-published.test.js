'use strict'
// Opt-in: untouched published TypeScript domain, using Node's built-in transform.
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { pathToFileURL } = require('node:url')
test('published task-board ledger produces compatible tasks, schedules and execution records', { skip: !process.env.DSH_TEST_TASK_BOARD_ROOT }, async t => {
  const root = path.resolve(process.env.DSH_TEST_TASK_BOARD_ROOT), home = fs.mkdtempSync(path.join(os.tmpdir(),'remote-published-board-'))
  const previous = { ...process.env }
  for (const key of Object.keys(process.env)) if (/proxy/i.test(key) || /^(TOKEN|TOKEN_FILE|DSH_)/.test(key)) delete process.env[key]
  Object.assign(process.env,{ HOME:home,USERPROFILE:home,DSH_HOME:home,DSH_REMOTE_FS_ROOT:home,TOKEN:'published-board-test-token' })
  let ledger
  t.after(() => {
    ledger?.dispose()
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous,key)) delete process.env[key]
    Object.assign(process.env,previous);fs.rmSync(home,{ recursive:true,force:true,maxRetries:5,retryDelay:100 })
  })
  const { HostTaskLedger } = await import(pathToFileURL(path.join(root,'src/host-ledger.ts')))
  const { TASK_BOARD_SCHEMA_VERSION } = await import(pathToFileURL(path.join(root,'src/protocol.ts')))
  const { summarizeTaskBoard } = await import('../packages/plugin/task-board.mjs')
  const now = Date.now()
  ledger = new HostTaskLedger(path.join(home,'ledger'),()=>now)
  const create = (id,workspaceId) => ledger.applyRequest('create-'+id,{kind:'create',id,input:{ title:'发布包任务 '+id,description:'契约验证',prompt:'SECRET PROMPT',workspaceId,skipVerification:true,
    schedule:{enabled:true,mode:'cron',cron:'0 9 * * 1-5',timeZone:'Asia/Shanghai'} }})
  create('own-task','workspace-a');create('foreign-task','workspace-b')
  const opened = ledger.applyRequest('run-own-task',{kind:'run',taskId:'own-task'})
  const execution = opened.state.tasks.find(row=>row.id==='own-task').executions.at(-1)
  ledger.attachSession('own-task',execution.id,'session-a')
  ledger.settle('own-task',execution.id,'failed','缺少验收证据',{text:'实际发布包执行摘要',seq:1})
  // These are the exact ledger fields the published service.snapshot() exposes;
  // the gateway runner/model stack is deliberately not started.
  const data = summarizeTaskBoard({schemaVersion:TASK_BOARD_SCHEMA_VERSION,...ledger.state()},{id:'workspace-a',sessionIds:['session-a']})
  assert.equal(data.tasks.length,1);assert.equal(data.tasks[0].status,'failed')
  assert.equal(data.tasks[0].executions.at(-1).sessionId,'session-a')
  assert.equal(data.tasks[0].executions.at(-1).summary,'实际发布包执行摘要')
  assert.equal(data.tasks[0].schedule.timeZone,'Asia/Shanghai');assert.ok(data.tasks[0].schedule.nextRunAt>now)
  assert.doesNotMatch(JSON.stringify(data),/SECRET|foreign-task/)
  t.diagnostic('Published @linxin666/dsh-client-ui-task-board '+JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version+' ledger verified with isolated files; no runtime peers, model calls or dependency installation.')
})
