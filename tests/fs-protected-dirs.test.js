'use strict'

/**
 * /fs 凭据目录隔离回归测试。
 *
 * 背景: 设备密钥同样可以访问 /fs, 而默认文件根是用户主目录(Windows 还含非系统盘),
 * 网关自己的 ~/.dsh-remote/token、device-keys.json 与安装目录都在其中, 等于把主令牌
 * 交给任何一把可撤销的设备密钥。本测试锁定: 受保护目录/文件在 list/read/preview/
 * upload-probe/upload/mkdir 全通道拒绝, 符号链接指向也一样, 正常文件不受影响。
 *
 * 隔离: 固定假 TOKEN、临时 HOME、临时文件根、不可达上游; 结束后 kill + rmSync。
 */

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { once } = require('node:events')

const REPO_ROOT = path.join(__dirname, '..')
const GATEWAY = path.join(REPO_ROOT, 'gateway.js')
const DEVICE_TOKEN = 'device-token-protected-dir-test'
const SECRET_MASTER = 'master-secret-should-never-leak'
const SECRET_OTHER_DEVICE = 'other-device-secret-should-never-leak'
const CUSTOM_TOKEN_FILE_NAME = 'custom-token.txt'

let home = ''
let tmpRoot = ''
let stateDir = ''
let junctionPath = ''
let junctionReady = false
let child = null
let base = ''

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function waitForHealth(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })
      if (res.ok) return
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('gateway did not become healthy: ' + (lastError?.message || lastError))
}

async function stopChild() {
  if (!child) return
  if (child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit').then(() => {}), new Promise(resolve => setTimeout(resolve, 2000))])
  }
  child = null
}

function startChild(port) {
  child = spawn(process.execPath, [GATEWAY], {
    cwd: REPO_ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PORT: String(port),
      HOST: '127.0.0.1',
      TOKEN: 'protected-dir-admin-token',
      TOKEN_FILE: path.join(home, CUSTOM_TOKEN_FILE_NAME),
      DSH_REMOTE_DEVICE_KEYS: path.join(stateDir, 'device-keys.json'),
      DSH_REMOTE_FS_ROOT: home,
      DSH_UPSTREAM: 'http://127.0.0.1:1',
      DSH_REMOTE_DSH_CONTROL_MODE: 'disabled',
      DSH_REMOTE_ANNOUNCEMENTS_URL: '',
      UPDATE_CHECK_URL: 'http://127.0.0.1:1/update',
      UPDATE_INTERVAL_MS: '3600000',
      UPDATE_PROXY: '',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: '*',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
}

function authHeaders() {
  return { authorization: `Bearer ${DEVICE_TOKEN}`, 'x-dsh-remote-client': 'app' }
}

function fsUrl(route, params = {}) {
  const query = new URLSearchParams(params).toString()
  return `${base}${route}${query ? `?${query}` : ''}`
}

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-fs-protect-'))
  home = path.join(tmpRoot, 'home')
  stateDir = path.join(home, '.dsh-remote')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(home, 'hello.txt'), 'legit-file-content')
  fs.writeFileSync(path.join(home, CUSTOM_TOKEN_FILE_NAME), SECRET_MASTER)
  fs.writeFileSync(path.join(stateDir, 'token'), SECRET_MASTER)
  fs.writeFileSync(path.join(stateDir, 'device-keys.json'), JSON.stringify({
    version: 1,
    enabled: true,
    keys: [
      { id: 'probe-device', note: 'probe', token: DEVICE_TOKEN, createdAt: Date.now(), updatedAt: Date.now(), lastUsedAt: 0, lastIp: '', lastKind: '' },
      { id: 'other-device', note: 'other', token: SECRET_OTHER_DEVICE, createdAt: Date.now(), updatedAt: Date.now(), lastUsedAt: 0, lastIp: '', lastKind: '' },
    ],
  }, null, 2))

  junctionPath = path.join(home, 'link-to-state')
  try {
    fs.symlinkSync(stateDir, junctionPath, process.platform === 'win32' ? 'junction' : 'dir')
    junctionReady = true
  } catch {
    junctionReady = false
  }

  const port = await getFreePort()
  base = `http://127.0.0.1:${port}`
  startChild(port)
  await waitForHealth(base)
})

after(async () => {
  await stopChild()
  if (tmpRoot) {
    const target = path.resolve(tmpRoot)
    if (target.startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(target, { recursive: true, force: true })
    tmpRoot = ''
  }
})

test('受保护状态目录不出现在列表中, 目录本身被拒绝', async () => {
  const listRes = await fetch(fsUrl('/fs/list', { path: home }), { headers: authHeaders() })
  assert.equal(listRes.status, 200)
  const list = await listRes.json()
  assert.ok(!list.entries.some(entry => entry.name === '.dsh-remote'), '状态目录不应出现在列表')
  if (junctionReady) assert.ok(!list.entries.some(entry => entry.name === 'link-to-state'), '指向状态目录的链接不应出现在列表')

  const stateRes = await fetch(fsUrl('/fs/list', { path: stateDir }), { headers: authHeaders() })
  assert.equal(stateRes.status, 403)
  assert.equal((await stateRes.json()).error, 'forbidden')
  if (junctionReady) {
    const linkRes = await fetch(fsUrl('/fs/list', { path: junctionPath }), { headers: authHeaders() })
    assert.equal(linkRes.status, 403, '经链接进入状态目录也必须拒绝')
  }
})

test('设备密钥读不到主令牌与其它设备密钥', async () => {
  for (const target of [
    path.join(stateDir, 'token'),
    path.join(stateDir, 'device-keys.json'),
    path.join(home, CUSTOM_TOKEN_FILE_NAME),
  ]) {
    const res = await fetch(fsUrl('/fs/file', { path: target }), { headers: authHeaders() })
    assert.equal(res.status, 403, target)
    const body = await res.text()
    assert.ok(!body.includes(SECRET_MASTER), target + ': 不能泄露主令牌')
    assert.ok(!body.includes(SECRET_OTHER_DEVICE), target + ': 不能泄露其它设备密钥')

    const preview = await fetch(fsUrl('/fs/preview', { path: target }), { headers: authHeaders() })
    assert.equal(preview.status, 403, 'preview ' + target)
  }

  if (junctionReady) {
    const res = await fetch(fsUrl('/fs/file', { path: path.join(junctionPath, 'token') }), { headers: authHeaders() })
    assert.equal(res.status, 403, '经链接读取令牌也必须拒绝')
    assert.ok(!(await res.text()).includes(SECRET_MASTER))
  }
})

test('上传与建目录不能写入受保护目录或受保护文件', async () => {
  const inState = await fetch(fsUrl('/fs/upload', { path: stateDir, name: 'evil.txt', overwrite: '1' }), {
    method: 'POST', headers: authHeaders(), body: 'x',
  })
  assert.equal(inState.status, 403)

  const probe = await fetch(fsUrl('/fs/upload-probe', { path: home, name: CUSTOM_TOKEN_FILE_NAME }), { headers: authHeaders() })
  assert.equal(probe.status, 403, '不能探测受保护文件的覆盖状态')

  const overwriteToken = await fetch(fsUrl('/fs/upload', { path: home, name: CUSTOM_TOKEN_FILE_NAME, overwrite: '1' }), {
    method: 'POST', headers: authHeaders(), body: 'replaced',
  })
  assert.equal(overwriteToken.status, 403)
  assert.equal(fs.readFileSync(path.join(home, CUSTOM_TOKEN_FILE_NAME), 'utf8'), SECRET_MASTER, '受保护文件内容不得被改写')

  const mkdirState = await fetch(fsUrl('/fs/mkdir', { path: stateDir, name: 'sub' }), { method: 'POST', headers: authHeaders() })
  assert.equal(mkdirState.status, 403)
  if (junctionReady) {
    const mkdirLink = await fetch(fsUrl('/fs/mkdir', { path: junctionPath, name: 'sub' }), { method: 'POST', headers: authHeaders() })
    assert.equal(mkdirLink.status, 403, '经链接建目录也必须拒绝')
  }
})

test('网关安装目录同样不对 /fs 开放', async () => {
  const res = await fetch(fsUrl('/fs/file', { path: path.join(REPO_ROOT, 'package.json') }), { headers: authHeaders() })
  assert.equal(res.status, 403)
  assert.ok(!(await res.text()).includes('dsh-remote'))
  const listRes = await fetch(fsUrl('/fs/list', { path: REPO_ROOT }), { headers: authHeaders() })
  assert.equal(listRes.status, 403)
})

test('普通文件与目录仍然可用', async () => {
  const res = await fetch(fsUrl('/fs/file', { path: path.join(home, 'hello.txt') }), { headers: authHeaders() })
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'legit-file-content')

  const mkdir = await fetch(fsUrl('/fs/mkdir', { path: home, name: 'new-dir' }), { method: 'POST', headers: authHeaders() })
  assert.equal(mkdir.status, 201)
  assert.ok(fs.statSync(path.join(home, 'new-dir')).isDirectory())
})
