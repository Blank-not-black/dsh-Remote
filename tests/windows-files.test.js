'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')

function frontendPathApi(relative) {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
  const mobile = relative === 'public/app.js'
  const start = source.indexOf(mobile ? 'function fsJoin' : 'function fsParent')
  const end = source.indexOf(mobile ? 'const FS_PREVIEW_EXTENSIONS' : 'async function openWorkspaceModal', start)
  assert.notEqual(start, -1, `${relative} path helper start`)
  assert.notEqual(end, -1, `${relative} path helper end`)
  const context = {}
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)}\nthis.pathApi = { fsJoin, fsParent, fsPathMeta, fsPathEqual, fsPathInside }`, context)
  return { source, api: context.pathApi }
}

test('手机和桌面文件树正确处理 Windows 盘符、大小写、UNC 与 POSIX 路径', () => {
  for (const relative of ['public/app.js', 'public/desktop/desktop.js']) {
    const { api } = frontendPathApi(relative)
    assert.equal(api.fsJoin('C:\\Users\\Alice', 'Documents'), 'C:\\Users\\Alice\\Documents')
    assert.equal(api.fsJoin('C:/Users/Alice', 'Documents'), 'C:\\Users\\Alice\\Documents')
    assert.equal(api.fsParent('C:\\Users\\Alice\\Documents'), 'C:\\Users\\Alice')
    assert.equal(api.fsParent('C:\\'), 'C:\\')
    assert.equal(api.fsParent('\\\\server\\share\\folder'), '\\\\server\\share')
    assert.equal(api.fsParent('\\\\server\\share'), '\\\\server\\share')
    assert.equal(api.fsPathInside('c:\\USERS\\Alice\\Documents', 'C:\\Users\\Alice'), true)
    assert.equal(api.fsPathInside('C:\\Users\\Bob', 'C:\\Users\\Alice'), false)
    assert.equal(api.fsParent('/home/alice/Documents'), '/home/alice')
    assert.equal(api.fsPathInside('/home/alice/Documents', '/home/alice'), true)
  }
})

test('网关的允许根判断覆盖盘符根、大小写与 UNC share，且拒绝跨根', () => {
  const source = fs.readFileSync(path.join(ROOT, 'gateway.js'), 'utf8')
  const start = source.indexOf('function fsInsideRootFor')
  const end = source.indexOf('function fsWorkspacePath', start)
  const context = { path, process }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)}\nthis.fsInsideRootFor = fsInsideRootFor`, context)
  const inside = context.fsInsideRootFor
  assert.equal(inside(path.win32, 'C:\\Users\\Alice', 'C:\\', true), true)
  assert.equal(inside(path.win32, 'c:\\USERS\\Alice\\Documents', 'C:\\Users\\Alice', true), true)
  assert.equal(inside(path.win32, 'D:\\Data', 'C:\\', true), false)
  assert.equal(inside(path.win32, '\\\\server\\share\\folder', '\\\\server\\share', true), true)
  assert.equal(inside(path.win32, '\\\\server\\other', '\\\\server\\share', true), false)
})

test('网关在 Windows 上同时解析波浪号正反斜杠和绝对盘符根', () => {
  const source = fs.readFileSync(path.join(ROOT, 'gateway.js'), 'utf8')
  const start = source.indexOf('function fsConfiguredRoot')
  const end = source.indexOf('const FS_ROOTS', start)
  const context = { path: path.win32, FS_DEFAULT_ROOT: 'C:\\Users\\Alice' }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)}\nthis.fsConfiguredRoot = fsConfiguredRoot`, context)
  const configuredRoot = context.fsConfiguredRoot
  assert.equal(configuredRoot('~\\Documents'), 'C:\\Users\\Alice\\Documents')
  assert.equal(configuredRoot('~/Documents'), 'C:\\Users\\Alice\\Documents')
  assert.equal(configuredRoot('D:\\Data'), 'D:\\Data')
  assert.equal(configuredRoot('\\\\server\\share'), '\\\\server\\share\\')
})

test('文件列表返回完整条目路径和允许根，切换服务器会清理旧主机路径', () => {
  const gateway = fs.readFileSync(path.join(ROOT, 'gateway.js'), 'utf8')
  const mobile = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
  const desktop = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.js'), 'utf8')
  const desktopHtml = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.html'), 'utf8')
  assert.match(gateway, /name: d\.name,\s*path: full,/)
  assert.match(gateway, /roots: FS_ROOTS,\s*platform: process\.platform,\s*separator: path\.sep/)
  assert.match(mobile, /resetFsForServer\(\)[\s\S]{0,120}state\.server = chosen/)
  assert.match(desktop, /resetFsForServerDesktop\(\)[\s\S]{0,120}state\.server = chosen/)
  assert.match(desktop, /e\.path \|\| fsJoin\(data\.path, e\.name\)/)
  assert.match(desktopHtml, /id="fs-root"/)
})

test('Windows 文件专项 CI 使用原生 runner 并执行真实网关测试', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/windows-files.yml'), 'utf8')
  const releaseWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/release-build.yml'), 'utf8')
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.match(workflow, /runs-on:\s*windows-latest/)
  assert.match(workflow, /pull_request:/)
  assert.match(workflow, /workflow_call:/)
  assert.match(workflow, /npm run test-windows-files/)
  assert.match(releaseWorkflow, /windows-files:\s*\n\s+uses:\s+\.\/\.github\/workflows\/windows-files\.yml/)
  assert.match(releaseWorkflow, /build:\s*\n\s+needs:\s+windows-files/)
  assert.match(packageJson.scripts['test-windows-files'], /tests\/windows-gateway\.test\.js/)
})
