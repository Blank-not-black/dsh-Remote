'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const { createSelection } = require('../public/session-deck.js')
const row = (kind, id = kind) => ({ kind, key: kind + ':' + id })
test('a new conversation surfaces consent before context; later notifications preserve the selected card', () => {
  const c = createSelection(), goal = row('goal'), tasks = row('todos'), file = row('file', 'a'), approval = row('approval', 'b')
  assert.equal(c.sync([goal, tasks, file], 's1'), 2)
  c.select(0)
  c.sync([goal, tasks, file, approval], 's1')
  assert.equal(c.rows[c.index].key, goal.key, 'never interrupt an in-progress card interaction')
  c.sync([goal, tasks, file, approval], 's2')
  assert.equal(c.rows[c.index].key, approval.key)
})
test('source redraws and insertions retain the stable request; completing one selects its next sibling', () => {
  const c = createSelection(), a = row('file', 'a'), b = row('file', 'b'), goal = row('goal')
  c.sync([goal, a, b], 's'); c.select(2)
  c.sync([row('file', 'new'), { ...goal }, { ...a }, { ...b }], 's')
  assert.equal(c.rows[c.index].key, b.key)
  c.sync([goal, a], 's'); assert.equal(c.rows[c.index].key, a.key)
  c.sync([goal], 's'); assert.equal(c.index, 0)
  c.sync([], 's'); assert.equal(c.index, -1)
  c.sync([a], 's'); assert.equal(c.index, 0)
})
test('switching conversations restores the chosen card; host identity reset clears remembered selections', () => {
  const c = createSelection(), rows = [row('goal'), row('file')]
  c.sync(rows, 'a'); c.select(0); c.sync(rows, 'b'); assert.equal(c.index, 1)
  c.sync(rows, 'a'); assert.equal(c.index, 0)
  c.reset(); c.sync(rows, 'a'); assert.equal(c.index, 1)
})
test('navigation has finite edges and remembers only a bounded number of conversations', () => {
  const c = createSelection(), rows = [row('goal'), row('file')]
  c.sync(rows, 'first'); c.select(-5); assert.equal(c.index, 0)
  c.select(99); assert.equal(c.index, 1); c.select(0)
  for (let i = 0; i < 15; i++) c.sync(rows, 'other-' + i)
  c.sync(rows, 'first'); assert.equal(c.index, 1)
})

test('task summaries prioritize actual work and report completed progress without changing the task order',()=>{
  const {taskView,taskHtml,goalState}=require('../public/session-deck.js')
  const items=[{status:'completed',content:'已完成步骤'},{status:'pending',content:'下个步骤'},{status:'in_progress',content:'<当前工作>'}]
  const info=taskView(items);assert.equal(info.done,1);assert.equal(info.total,3);assert.equal(info.current,items[2])
  const html=taskHtml(items);assert.match(html,/正在：&lt;当前工作&gt;/);assert.match(html,/1\/3 已完成/)
  assert.ok(html.indexOf('已完成步骤')>html.indexOf('<details'),'full list stays available behind disclosure')
  assert.equal(items[0].status,'completed');assert.equal(taskView([{status:'completed'}]).current,undefined)
  assert.match(taskHtml([{status:'completed',content:'done'}]),/全部任务已完成/)
  assert.equal(goalState('blocked'),'等待处理');assert.equal(goalState('paused'),'已暂停')
})

test('approval summaries retain denial and permission scope, escape host text, and keep full original arguments',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path')
  const c=vm.createContext({window:{I18N:{lang:'zh'}},Date,JSON})
  for(const file of ['approval-records.js','session-deck.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../public',file),'utf8'),c)
  const api=c.window.DshSessionDeck
  const raw='Auto review denied tool "pwsh": This command would delete files outside the workspace.'
  const html=api.approvalHtml({toolName:'<pwsh>',reason:raw,arguments:{command:'Remove-Item C:\\outside\\report.txt'}},raw+'\ncallId: original-call\n'+('x'.repeat(3000)))
  assert.match(html,/审查未通过/);assert.match(html,/此操作将删除工作区之外的文件/);assert.match(html,/允许一次/)
  assert.match(html,/命令: Remove-Item/);assert.match(html,/&lt;pwsh&gt;/);assert.doesNotMatch(html,/<pwsh>/)
  assert.ok(html.indexOf('callId: original-call')>html.indexOf('<details'))
  assert.ok(html.includes('x'.repeat(3000)))
  assert.match(api.approvalHtml({toolName:'pwsh',reason:'escalate sandbox to danger-full-access: 读取目标目录'},'full'),/申请：完整访问/)
  assert.match(api.approvalHtml({toolName:'unknown'},'full'),/主机未提供申请原因/)
  c.window.I18N.lang='en';assert.match(api.approvalHtml({toolName:'bash',reason:raw},'full'),/Allow once/)
  assert.equal(api.goalState('active'),'In progress')
})
