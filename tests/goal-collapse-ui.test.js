'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')

function collapseContext(source) {
  const start = source.indexOf("const COLLAPSED_GOALS_KEY = 'dshCollapsedGoalsV1'")
  const ends = ['\nfunction updatePendingBadge', '\nfunction onSessionEvent']
    .map(marker => source.indexOf(marker, start))
    .filter(index => index > start)
  const end = Math.min(...ends)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const storage = new Map()
  const context = {
    LS: {
      get(key, fallback) { return storage.has(key) ? storage.get(key) : fallback },
      set(key, value) { storage.set(key, value) }
    }
  }
  vm.createContext(context)
  vm.runInContext(source.slice(start, end) + '\nthis.api = { collapsedGoals, isGoalCollapsed, setGoalCollapsed }', context)
  return { ...context.api, storage }
}

test('目标收起状态只保存在本地，并按会话与目标 ID 隔离', () => {
  for (const relative of ['public/app.js', 'public/desktop/desktop.js']) {
    const { collapsedGoals, isGoalCollapsed, setGoalCollapsed } = collapseContext(read(relative))
    const goal = { id: 'goal-1', phase: 'active' }
    assert.equal(isGoalCollapsed('session-1', goal), false, relative)
    setGoalCollapsed('session-1', goal, true)
    assert.equal(isGoalCollapsed('session-1', goal), true, relative)
    assert.equal(isGoalCollapsed('session-2', goal), false, relative)
    assert.equal(isGoalCollapsed('session-1', { id: 'goal-2' }), false, relative)
    setGoalCollapsed('session-1', goal, false)
    assert.equal(isGoalCollapsed('session-1', goal), false, relative)
    assert.equal(collapsedGoals().length, 0)
  }
})

test('手机与桌面目标使用可恢复的侧边 disclosure，不把收起映射为目标 RPC', () => {
  for (const relative of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = read(relative)
    assert.match(source, /data-goal-collapse="1" aria-expanded="true" aria-controls="goal-panel-/, relative)
    assert.match(source, /data-goal-collapse="0" aria-expanded="false" aria-controls="goal-panel-/, relative)
    assert.match(source, /aria-label="\$\{esc\(t\('goal\.expand'\)\)\}"/, relative)
    assert.match(source, /requestAnimationFrame\(\(\) => box\.querySelector/, relative)
    assert.doesNotMatch(source, /map = \{[^}]*collapse:/, relative)
  }
  assert.match(read('public/styles.css'), /\.goal-side-tab[\s\S]{0,520}border-right: 0; border-radius: 12px 0 0 12px/)
  assert.match(read('public/desktop/desktop.css'), /\.ds-goal-side-tab[\s\S]{0,520}border-right: 0; border-radius: 11px 0 0 11px/)
})

test('收起与展开文案覆盖中英文，并明确目标仍在运行', () => {
  for (const relative of ['public/index.html', 'public/desktop/desktop.html']) {
    const source = read(relative)
    assert.match(source, /'goal\.collapse': '收起目标到侧边'/, relative)
    assert.match(source, /'goal\.collapsedHint': '仍在运行'/, relative)
    assert.match(source, /'goal\.collapse': 'Collapse goal to the side'/, relative)
    assert.match(source, /'goal\.collapsedHint': 'Still running'/, relative)
  }
})
