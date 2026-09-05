'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
const desktopHtml = fs.readFileSync(path.join(ROOT, 'public', 'desktop', 'desktop.html'), 'utf8')
const desktop = fs.readFileSync(path.join(ROOT, 'public', 'desktop', 'desktop.js'), 'utf8')

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

  test('桌面 WebUI 新建会话可选择 DSH 工作区并传递 workspaceId', () => {
  assert.match(desktopHtml, /id="modal-new-session"/)
  assert.match(desktopHtml, /id="new-session-workspace"/)
  assert.match(desktopHtml, /id="new-session-workspace-path"/)
  assert.match(desktop, /state\.workspaces/)
  assert.match(desktop, /function renderNewSessionWorkspace\(/)
  assert.match(desktop, /btn-new-session.*openNewSessionModal/)
  assert.match(desktop, /safeRpc\('session\.create', \{ workspaceId \}/)
  assert.match(desktop, /workspace\.create', \{ path: data\.path \}/)
  assert.match(desktop, /const sessionPayload = workspace\?\.workspaceId \? \{ workspaceId: workspace\.workspaceId \} : \{ cwd: data\.path \}/)
  })

  test('桌面 WebUI 为未命名会话显示友好名称并保留短标识', () => {
    assert.match(desktop, /function sessionTitleValue\(s\)/)
    assert.match(desktop, /function titleOf\(s\) \{ return sessionTitleValue\(s\) \|\| \(s\?\.sessionId \? t\('ds\.sessionUntitled'\)/)
    assert.match(desktop, /return `\$\{title\} · \$\{String\(s\.sessionId\)\.slice\(-8\)\}`/)
    assert.match(desktop, /const title = sessionLabelOf\(s\)/)
    assert.match(desktopHtml, /'ds\.sessionUntitled': '新会话'/)
  })
