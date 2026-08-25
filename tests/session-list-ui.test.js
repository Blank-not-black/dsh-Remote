'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const mobile = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
const desktop = fs.readFileSync(path.join(ROOT, 'public', 'desktop', 'desktop.js'), 'utf8')

function classifier(source, titleMarker, goalMarker) {
  const start = source.indexOf(titleMarker)
  const from = source.indexOf('function isTopLevelSession', start)
  const end = source.indexOf(goalMarker, from)
  assert.notEqual(from, -1)
  assert.notEqual(end, -1)
  const context = {}
  vm.createContext(context)
  vm.runInContext(`${source.slice(from, end)}\nthis.check = isTopLevelSession`, context)
  return context.check
}

test('顶层会话判定同时识别 parentSessionId 与 subagent origin', () => {
  for (const check of [
    classifier(mobile, 'function titleOf(', 'const GOAL_TERMINAL_PHASES'),
    classifier(desktop, 'function titleOf(', 'const GOAL_TERMINAL_PHASES'),
  ]) {
    assert.equal(check({ sessionId: 'root' }), true)
    assert.equal(check({ sessionId: 'child-by-parent', parentSessionId: 'root' }), false)
    assert.equal(check({ sessionId: 'child-by-origin', origin: 'subagent' }), false)
    assert.equal(check(null), false)
  }
})

test('手机和桌面的主列表、工作区树与主页统计统一使用顶层会话', () => {
  for (const source of [mobile, desktop]) {
    assert.match(source, /function topLevelSessions\(\) \{ return state\.sessions\.filter\(isTopLevelSession\) \}/)
    assert.match(source, /function sortedSessions\(\) \{\s*const items = topLevelSessions\(\)/)
    assert.match(source, /map\(sid => state\.byId\.get\(sid\)\)\.filter\(isTopLevelSession\)/)
    assert.match(source, /const topSessions = topLevelSessions\(\)\s*const running = topSessions\.filter\(s => s\.running\)\.length/)
  }
  assert.match(mobile, /const running = topLevelSessions\(\)\.filter\(s => s\.running\)\.length/)
})

test('子代理功能仍由主会话卡片提供，不删除子会话数据', () => {
  for (const source of [mobile, desktop]) {
    assert.match(source, /state\.sessions = v\.items \|\| \[\]/)
    assert.match(source, /state\.byId = new Map\(state\.sessions\.map/)
    assert.match(source, /subagent\.list', \{ parentSessionId: sessionId \}/)
  }
})

test('桌面端归档会话开关使用会话列表事件代理，可正常触发重绘', () => {
  assert.match(desktop, /\$\('session-list'\)\.addEventListener\('click', \(e\) => \{[\s\S]{0,260}data-archived-toggle[\s\S]{0,260}renderSessions\(\)/)
  assert.match(desktop, /LS\.set\('dsShowArchivedV1', LS\.get\('dsShowArchivedV1', '0'\) === '1' \? '0' : '1'\)/)
})
