'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')

const ROOT = path.resolve(__dirname, '..')
const GATEWAY = path.join(ROOT, 'gateway.js')
const TOKEN = 'windows-ci-token'

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function waitForHealth(base, child, logs, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`gateway exited before health check (${child.exitCode})\n${logs.join('')}`)
    }
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })
      if (response.ok) return
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`gateway did not become healthy: ${lastError?.message || 'timeout'}\n${logs.join('')}`)
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  child.kill()
  await Promise.race([
    once(child, 'exit').then(() => {}),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await Promise.race([
      once(child, 'exit').then(() => {}),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ])
  }
  assert.notEqual(child.exitCode, null, 'gateway child must exit before temporary files are removed')
}

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${TOKEN}`, ...extra }
}

test('Windows 原生网关支持盘符、多文件根、中文路径和 junction 防逃逸', {
  skip: process.platform !== 'win32',
  timeout: 45_000,
}, async (t) => {
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-windows-ci-'))
  const home = path.join(suiteRoot, 'home')
  const primaryRoot = path.join(suiteRoot, 'root-a')
  const secondaryRoot = path.join(suiteRoot, 'root-b')
  const outsideRoot = path.join(suiteRoot, 'outside')
  const unicodeDirectory = path.join(primaryRoot, '中文 空格')
  const sourceFile = path.join(unicodeDirectory, 'CaseFile.TXT')
  const junctionPath = path.join(primaryRoot, 'escape-junction')
  let child = null

  t.after(async () => {
    await stopChild(child)
    fs.rmSync(suiteRoot, { recursive: true, force: true })
  })

  for (const directory of [home, primaryRoot, secondaryRoot, outsideRoot, unicodeDirectory]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  fs.writeFileSync(sourceFile, 'windows-file-content')
  fs.writeFileSync(path.join(secondaryRoot, 'second-root.txt'), 'second-root-content')
  fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'must-not-leak')
  fs.symlinkSync(outsideRoot, junctionPath, 'junction')

  const port = await getFreePort()
  const base = `http://127.0.0.1:${port}`
  const logs = []
  child = spawn(process.execPath, [GATEWAY], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PORT: String(port),
      HOST: '127.0.0.1',
      TOKEN,
      TOKEN_FILE: path.join(home, '.dsh-remote', 'token'),
      DSH_UPSTREAM: 'http://127.0.0.1:1',
      DSH_REMOTE_FS_ROOT: [primaryRoot, secondaryRoot].join(path.delimiter),
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
  const collectLog = chunk => {
    if (logs.join('').length < 64 * 1024) logs.push(String(chunk))
  }
  child.stdout.on('data', collectLog)
  child.stderr.on('data', collectLog)
  child.on('error', collectLog)
  await waitForHealth(base, child, logs)

  const fsUrl = (route, params = {}) => {
    const query = new URLSearchParams(params).toString()
    return `${base}${route}${query ? `?${query}` : ''}`
  }

  let response = await fetch(fsUrl('/fs/list'), { headers: authHeaders() })
  assert.equal(response.status, 200)
  let body = await response.json()
  assert.equal(body.path, primaryRoot)
  assert.deepEqual(body.roots, [primaryRoot, secondaryRoot])
  assert.equal(body.platform, 'win32')
  assert.equal(body.separator, '\\')
  assert.ok(body.entries.some(entry => entry.name === '中文 空格' && entry.path === unicodeDirectory))
  assert.ok(!body.entries.some(entry => entry.name === 'escape-junction'))

  const caseVariantRoot = path.join(path.dirname(primaryRoot), path.basename(primaryRoot).toUpperCase())
  response = await fetch(fsUrl('/fs/list', { path: caseVariantRoot }), { headers: authHeaders() })
  assert.equal(response.status, 200)

  response = await fetch(fsUrl('/fs/list', { path: secondaryRoot }), { headers: authHeaders() })
  assert.equal(response.status, 200)
  body = await response.json()
  assert.ok(body.entries.some(entry => entry.name === 'second-root.txt'))

  for (const forbiddenPath of [outsideRoot, path.join(primaryRoot, '..'), junctionPath]) {
    response = await fetch(fsUrl('/fs/list', { path: forbiddenPath }), { headers: authHeaders() })
    assert.equal(response.status, 403, forbiddenPath)
    assert.equal((await response.json()).error, 'forbidden')
  }

  response = await fetch(fsUrl('/fs/file', { path: sourceFile }), { headers: authHeaders() })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'windows-file-content')

  const uploadName = '上传 文件.txt'
  const uploadContent = Buffer.from('uploaded-on-windows')
  const uploadSha256 = crypto.createHash('sha256').update(uploadContent).digest('hex')
  response = await fetch(fsUrl('/fs/upload', {
    path: secondaryRoot,
    name: uploadName,
    session: 'windows-ci-upload',
    offset: 0,
    finish: 1,
    sha256: uploadSha256,
  }), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/octet-stream' }),
    body: uploadContent,
  })
  assert.equal(response.status, 201)
  assert.equal(fs.readFileSync(path.join(secondaryRoot, uploadName), 'utf8'), 'uploaded-on-windows')

  response = await fetch(fsUrl('/fs/preview', { path: path.join(secondaryRoot, uploadName) }), {
    headers: authHeaders(),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).content, 'uploaded-on-windows')

  response = await fetch(fsUrl('/fs/mkdir', { path: primaryRoot, name: '新建 工作区' }), {
    method: 'POST',
    headers: authHeaders(),
  })
  assert.equal(response.status, 201)
  assert.equal(fs.statSync(path.join(primaryRoot, '新建 工作区')).isDirectory(), true)
})
