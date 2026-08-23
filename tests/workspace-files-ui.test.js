'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')

test('手机会话页提供工作区筛选，并在新会话中显示完整路径和切换入口', () => {
  assert.match(html, /id="session-workspace-filter"/)
  assert.match(html, /id="modal-new-session"/)
  assert.match(html, /id="new-session-workspace"/)
  assert.match(html, /id="new-session-workspace-name"/)
  assert.match(html, /id="new-session-workspace-path"/)
  assert.match(app, /session\.create', \{ workspaceId:/)
  assert.match(app, /workspaceOwnsSession/)
  assert.match(app, /workspace\.sessionIds\.some/)
  assert.match(app, /cwdKey\.startsWith/)
  assert.match(app, /workspaceOwnsSession\(workspaceById\(state\.workspaceFilter\), s\)/)
  assert.match(app, /state\.wbProjects = state\.wbProjects\.filter\(w => !wbStrictInside/)
})

test('文件页可选择 DSH 工作区，常见文本走受限预览且 Markdown 可切换渲染', () => {
  assert.match(html, /id="fs-workspace"/)
  assert.match(html, /id="modal-file-preview"/)
  assert.match(html, /id="file-preview-rendered"/)
  assert.match(app, /fsApiUrl\('\/preview'/)
  assert.match(app, /window\.mdToHtml/)
})
