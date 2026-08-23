'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')

function between(start, end) {
  const from = app.indexOf(start)
  const to = app.indexOf(end, from)
  assert.notEqual(from, -1, `missing ${start}`)
  assert.notEqual(to, -1, `missing ${end}`)
  return app.slice(from, to)
}

const source = [
  between('function wbPathKey(', 'function wbBaseName('),
  between('function workspaceOwnsSession(', 'function workspaceForSession('),
  between('function sessionCwd(', 'function sessionWorkspaceLabel('),
].join('\n')

function owns(workspace, session) {
  const context = { navigator: { platform: 'Linux', userAgent: 'Linux' }, workspace, session, answer: false }
  vm.runInNewContext(`${source}\nanswer = workspaceOwnsSession(workspace, session)`, context)
  return context.answer
}

test('会话工作区归属兼容 DSH 成员列表、显式 workspaceId 和子目录 cwd', () => {
  const workspace = { workspaceId: 'ws-1', path: '/projects/alpha', sessionIds: ['member-session'] }
  assert.equal(owns(workspace, { sessionId: 'member-session', cwd: '/elsewhere' }), true)
  assert.equal(owns(workspace, { sessionId: 'explicit-session', workspaceId: 'ws-1', cwd: '/elsewhere' }), true)
  assert.equal(owns(workspace, { sessionId: 'nested-session', cwd: '/projects/alpha/packages/mobile' }), true)
  assert.equal(owns(workspace, { sessionId: 'sibling-session', cwd: '/projects/alpha-copy' }), false)
})
