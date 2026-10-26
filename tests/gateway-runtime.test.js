'use strict'

/**
 * resolveGatewayRuntime 黑盒测试：网关解释器发现的优先级、拒绝原因、
 * 桌面运行时复制/复用以及失败回退。
 *
 * 全部通过注入的 env/home/execPath/platform/probe/copyRuntime/log 在临时目录完成：
 * 不执行真实运行时复制，不触碰真实 ~/.dsh-remote，也不启动网关。
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
const PLUGIN = path.join(ROOT, 'packages/plugin/index.mjs')
const GATEWAY_SCRIPT = path.join(ROOT, 'packages/plugin/gateway.cjs')
const WIN32 = 'win32'
const RUNTIME_VERSION = '24.21.0'
const RUNTIME_MAJOR = 24
const HOST_VERSION = '24.14.1'
const HOST_MAJOR = 24
const SKIP_MARK = '网关解释器候选跳过'

let pluginModule = null
async function loadPlugin() {
  if (!pluginModule) {
    pluginModule = await import(pathToFileURL(PLUGIN).href + `?gateway-runtime=${Date.now()}`)
  }
  return pluginModule
}

async function resolveGatewayRuntime(options) {
  const plugin = await loadPlugin()
  assert.equal(typeof plugin.resolveGatewayRuntime, 'function',
    'packages/plugin/index.mjs 必须导出 async function resolveGatewayRuntime(options)')
  return plugin.resolveGatewayRuntime(options)
}

function makeBox(t, label, { hostInside = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-gw-runtime-${label}-`))
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }) } catch {}
  })
  const home = path.join(root, 'home')
  const hostExec = hostInside
    ? path.join(root, 'dsh-install', 'DSH.exe')
    : path.join(root, 'host-bin', 'node.exe')
  const installDir = path.resolve(path.dirname(hostExec))
  fs.mkdirSync(home, { recursive: true })
  writeFake(hostExec, 'fake desktop host executable')
  fs.mkdirSync(path.join(installDir, 'resources'), { recursive: true })
  fs.writeFileSync(path.join(installDir, 'resources', 'app.asar'), 'fake app.asar')
  return {
    root,
    home,
    hostExec,
    installDir,
    sourceNode: path.join(installDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    targetNode(version = RUNTIME_VERSION) {
      return path.join(home, '.dsh-remote', 'runtime', `node-${version}.exe`)
    },
  }
}

function writeFake(file, content = 'fake-node-runtime') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

function normalizePath(file) {
  let value = String(file)
  if (process.platform === 'win32') {
    value = value.replace(/^\\\\\?\\/, '')
    value = value.replace(/\//g, '\\')
    return path.resolve(value).toLowerCase()
  }
  return path.resolve(value)
}

function version(value, major = Number(String(value).split('.')[0])) {
  return { ok: true, version: String(value), major }
}

function createFakeProbe(entries = {}) {
  const table = new Map()
  const calls = []
  const probe = (file) => {
    calls.push(file)
    const result = table.get(normalizePath(file))
    if (!result) return { ok: false, code: 'ENOENT', detail: `ENOENT: ${file}` }
    return { ...result }
  }
  probe.calls = calls
  probe.set = (file, result) => {
    table.set(normalizePath(file), result)
    return probe
  }
  for (const [file, result] of Object.entries(entries)) probe.set(file, result)
  return probe
}

function createFakeCopyRuntime(onCopy) {
  const calls = []
  const copyRuntime = async (source, target) => {
    calls.push({ source, target })
    if (onCopy) return onCopy(source, target)
    writeFake(target)
    return { ok: true, bytes: Buffer.byteLength('fake-node-runtime') }
  }
  copyRuntime.calls = calls
  return copyRuntime
}

function captureLog() {
  const lines = []
  return { lines, fn: (message) => { lines.push(String(message)) } }
}

function attemptCodes(result) {
  return (result.attempts || []).map((attempt) => attempt.code)
}

/** 每个被拒候选都必须有一行 "网关解释器候选跳过: <source> <candidate> - <detail>"。 */
function assertSkipLogged(lines, attempt) {
  const marker = attempt.candidate ? String(attempt.candidate) : '(未提供)'
  const matched = lines.filter((line) =>
    line.includes(SKIP_MARK) && line.includes(String(attempt.source)) && line.includes(marker))
  assert.ok(matched.length > 0,
    `缺少 ${attempt.source}/${attempt.code} 的跳过日志 (candidate=${marker}): ${JSON.stringify(lines)}`)
  const reason = typeof attempt.detail === 'string' && attempt.detail ? attempt.detail : attempt.code
  assert.ok(matched.some((line) => line.includes(reason)),
    `跳过日志缺少 ${attempt.source}/${attempt.code} 的原因/detail (${reason}): ${JSON.stringify(matched)}`)
}

// ---------------------------------------------------------------------------
// 1. 优先级 env > PATH > desktop-runtime > host
// ---------------------------------------------------------------------------
test('解析优先级: env > PATH > desktop-runtime > host', async (t) => {
  const box = makeBox(t, 'priority', { hostInside: true })
  const envNode = writeFake(path.join(box.root, 'env-node', 'node.exe'))
  const pathDir = path.join(box.root, 'path-bin')
  const pathNode = writeFake(path.join(pathDir, 'node.exe'))
  const sourceNode = writeFake(box.sourceNode)
  const target = box.targetNode()
  const emptyPathDir = path.join(box.root, 'empty-bin')
  fs.mkdirSync(emptyPathDir, { recursive: true })

  const probe = createFakeProbe({
    [envNode]: version(RUNTIME_VERSION),
    [pathNode]: version(RUNTIME_VERSION),
    [sourceNode]: version(RUNTIME_VERSION),
    [box.hostExec]: version(HOST_VERSION),
  })
  const copyRuntime = createFakeCopyRuntime((source, destination) => {
    writeFake(destination)
    probe.set(destination, version(RUNTIME_VERSION))
    return { ok: true, bytes: Buffer.byteLength('fake-node-runtime') }
  })
  const log = captureLog()
  const common = {
    home: box.home, execPath: box.hostExec, platform: WIN32,
    probe, copyRuntime, log: log.fn,
  }
  const missingEnv = path.join(box.root, 'missing', 'node.exe')

  // 1) env 高于 PATH（关闭桌面宿主，隔离环境候选探测）。
  const fromEnv = await resolveGatewayRuntime({
    ...common, desktopHost: false,
    env: { DSH_REMOTE_NODE: envNode, PATH: pathDir },
  })
  assert.equal(fromEnv.source, 'env')
  assert.equal(fromEnv.executable, envNode)
  assert.equal(fromEnv.version, RUNTIME_VERSION)
  assert.equal(fromEnv.major, RUNTIME_MAJOR)
  assert.equal(fromEnv.installDir, box.installDir)
  assert.equal(fromEnv.desktopHost, false)
  assert.equal(fromEnv.copy, null)
  assert.equal(fromEnv.candidates[0].source, 'env')
  assert.equal(fromEnv.candidates.at(-1).source, 'host')
  assert.equal(fromEnv.candidates.at(-1).executable, box.hostExec)
  assert.equal(
    new Set(fromEnv.candidates.map((candidate) => normalizePath(candidate.executable))).size,
    fromEnv.candidates.length,
    'candidates 必须按 executable 去重',
  )
  assert.equal(copyRuntime.calls.length, 0)

  // 2) env 无效时 PATH 优先于 host。
  const fromPath = await resolveGatewayRuntime({
    ...common, desktopHost: false,
    env: { DSH_REMOTE_NODE: missingEnv, PATH: pathDir },
  })
  assert.equal(fromPath.source, 'path')
  assert.equal(fromPath.executable, pathNode)
  assert.equal(fromPath.version, RUNTIME_VERSION)
  assert.ok(fromPath.attempts.some((attempt) => attempt.source === 'env' && attempt.code === 'MISSING'),
    `env 缺失应记录 MISSING: ${JSON.stringify(fromPath.attempts)}`)

  // 3) env + PATH 都不可用时使用桌面运行时副本。
  const fromDesktop = await resolveGatewayRuntime({
    ...common, desktopHost: true,
    env: { DSH_REMOTE_NODE: missingEnv, PATH: emptyPathDir },
  })
  assert.equal(fromDesktop.source, 'desktop-runtime')
  assert.equal(fromDesktop.executable, target)
  assert.ok(fromDesktop.copy, '复制后 copy 必须非空')
  assert.equal(fromDesktop.copy.reused, false)
  assert.equal(copyRuntime.calls.length, 1)
  assert.equal(copyRuntime.calls[0].source, sourceNode)
  assert.equal(copyRuntime.calls[0].target, target)
  assert.ok(fromDesktop.attempts.some((attempt) => attempt.source === 'path' && attempt.code === 'NOT_FOUND'),
    `PATH 无 node 应记录 NOT_FOUND: ${JSON.stringify(fromDesktop.attempts)}`)
  assert.equal(fromDesktop.candidates[0].source, 'desktop-runtime')
  assert.equal(fromDesktop.candidates.at(-1).source, 'host')

  // 4) 桌面运行时源不存在时必须退回 host（不能只凭 home 里旧副本就复用）。
  fs.rmSync(sourceNode)
  const fromHost = await resolveGatewayRuntime({
    ...common, desktopHost: true,
    env: { DSH_REMOTE_NODE: missingEnv, PATH: emptyPathDir },
  })
  assert.equal(fromHost.source, 'host')
  assert.equal(fromHost.executable, box.hostExec)
  assert.equal(fromHost.version, HOST_VERSION)
  assert.ok(fromHost.attempts.some((attempt) => attempt.source === 'desktop-runtime' && attempt.code === 'SOURCE_MISSING'),
    `桌面运行时缺失应记录 SOURCE_MISSING: ${JSON.stringify(fromHost.attempts)}`)
  assert.equal(fromHost.candidates.at(-1).source, 'host')
})

// ---------------------------------------------------------------------------
// 2. DSH_REMOTE_NODE 无效: 缺失 / 相对路径 / 探测失败
// ---------------------------------------------------------------------------
test('DSH_REMOTE_NODE 缺失/相对/探测失败: 记录原因并回退 PATH', async (t) => {
  const box = makeBox(t, 'invalid-env', { hostInside: false })
  const pathDir = path.join(box.root, 'path-bin')
  const pathNode = writeFake(path.join(pathDir, 'node.exe'))
  const brokenNode = writeFake(path.join(box.root, 'broken-env', 'node.exe'))
  const probe = createFakeProbe({
    [pathNode]: version(RUNTIME_VERSION),
    [brokenNode]: { ok: false, code: 'EPERM', detail: 'EACCES: permission denied' },
    [box.hostExec]: version(HOST_VERSION),
  })
  const common = {
    home: box.home, execPath: box.hostExec, platform: WIN32, desktopHost: false,
    probe, copyRuntime: createFakeCopyRuntime(), log: captureLog().fn,
  }

  const missing = await resolveGatewayRuntime({
    ...common,
    env: { DSH_REMOTE_NODE: path.join(box.root, 'missing-env', 'node.exe'), PATH: pathDir },
  })
  assert.equal(missing.source, 'path')
  assert.equal(missing.executable, pathNode)
  assert.ok(missing.attempts.some((attempt) => attempt.source === 'env' && attempt.code === 'MISSING'),
    `缺失的绝对路径应记录 MISSING: ${JSON.stringify(missing.attempts)}`)

  const relative = await resolveGatewayRuntime({
    ...common,
    env: { DSH_REMOTE_NODE: path.join('bin', 'node.exe'), PATH: pathDir },
  })
  assert.equal(relative.source, 'path')
  assert.equal(relative.executable, pathNode)
  assert.ok(relative.attempts.some((attempt) => attempt.source === 'env' && attempt.code === 'NOT_ABSOLUTE'),
    `相对路径应记录 NOT_ABSOLUTE: ${JSON.stringify(relative.attempts)}`)

  const probeFailed = await resolveGatewayRuntime({
    ...common,
    env: { DSH_REMOTE_NODE: brokenNode, PATH: pathDir },
  })
  assert.equal(probeFailed.source, 'path')
  assert.equal(probeFailed.executable, pathNode)
  assert.ok(probeFailed.attempts.some((attempt) => attempt.source === 'env' && attempt.code === 'PROBE_FAILED'),
    `探测失败的候选应记录 PROBE_FAILED: ${JSON.stringify(probeFailed.attempts)}`)
})

// ---------------------------------------------------------------------------
// 3. node 主版本 < 18 拒绝
// ---------------------------------------------------------------------------
test('node 主版本低于 18 的候选被拒绝并继续下一个', async (t) => {
  const box = makeBox(t, 'old-node', { hostInside: false })
  const oldNode = writeFake(path.join(box.root, 'old-node', 'node.exe'))
  const pathDir = path.join(box.root, 'path-bin')
  const pathNode = writeFake(path.join(pathDir, 'node.exe'))
  const probe = createFakeProbe({
    [oldNode]: version('16.20.0', 16),
    [pathNode]: version(RUNTIME_VERSION),
    [box.hostExec]: version(HOST_VERSION),
  })
  const result = await resolveGatewayRuntime({
    env: { DSH_REMOTE_NODE: oldNode, PATH: pathDir },
    home: box.home, execPath: box.hostExec, platform: WIN32, desktopHost: false,
    probe, copyRuntime: createFakeCopyRuntime(), log: captureLog().fn,
  })
  assert.equal(result.source, 'path')
  assert.equal(result.executable, pathNode)
  assert.equal(result.version, RUNTIME_VERSION)
  assert.equal(result.major, RUNTIME_MAJOR)
  assert.ok(result.attempts.some((attempt) => attempt.source === 'env' && attempt.code === 'VERSION_TOO_OLD'),
    `v16 候选应记录 VERSION_TOO_OLD: ${JSON.stringify(result.attempts)}`)
})

// ---------------------------------------------------------------------------
// 4. 安装目录内的候选在 desktopHost 下被拒绝
// ---------------------------------------------------------------------------
test('desktopHost 时落在 DSH 安装目录内的解释器候选被拒绝', async (t) => {
  const box = makeBox(t, 'inside-install', { hostInside: true })
  const envInside = writeFake(path.join(box.installDir, 'node.exe'))
  const pathInsideDir = path.join(box.installDir, 'bin')
  const pathInside = writeFake(path.join(pathInsideDir, 'node.exe'))
  const sourceNode = writeFake(box.sourceNode)
  const outsideDir = path.join(box.root, 'outside-bin')
  const outsideNode = writeFake(path.join(outsideDir, 'node.exe'))
  const target = box.targetNode()

  const probe = createFakeProbe({
    [envInside]: version(RUNTIME_VERSION),
    [pathInside]: version(RUNTIME_VERSION),
    [sourceNode]: version(RUNTIME_VERSION),
    [outsideNode]: version(RUNTIME_VERSION),
    [box.hostExec]: version(HOST_VERSION),
  })
  const copyRuntime = createFakeCopyRuntime((source, destination) => {
    writeFake(destination)
    probe.set(destination, version(RUNTIME_VERSION))
    return { ok: true, bytes: Buffer.byteLength('fake-node-runtime') }
  })
  const base = {
    home: box.home, execPath: box.hostExec, platform: WIN32, desktopHost: true,
    probe, copyRuntime, log: captureLog().fn,
  }

  const result = await resolveGatewayRuntime({
    ...base,
    env: { DSH_REMOTE_NODE: envInside, PATH: pathInsideDir },
  })
  // 选中目录外的副本时结果不再告警（warning 跟随选中候选）；
  // 但安装目录内的 host 候选本身必须被标记 insideInstallDir。
  assert.equal(result.candidates.at(-1).source, 'host')
  assert.equal(result.candidates.at(-1).insideInstallDir, true)
  const insideAttempts = result.attempts.filter((attempt) => attempt.code === 'INSIDE_INSTALL_DIR')
  assert.ok(insideAttempts.length >= 2,
    `env 与 PATH 的安装目录内候选都应被拒绝: ${JSON.stringify(result.attempts)}`)
  assert.ok(insideAttempts.some((attempt) => attempt.source === 'env'))
  assert.ok(insideAttempts.some((attempt) => attempt.source === 'path'))
  assert.equal(result.source, 'desktop-runtime')
  assert.equal(result.executable, target)

  // Windows 路径变体（大小写、正斜杠、\\?\ 前缀）仍应视为安装目录内。
  const upperSlashed = envInside.replace(/\\/g, '/').toUpperCase()
  const variant = await resolveGatewayRuntime({ ...base, env: { DSH_REMOTE_NODE: upperSlashed, PATH: outsideDir } })
  assert.equal(variant.source, 'path', '安装目录内候选被拒后应使用目录外的 PATH node')
  assert.ok(variant.attempts.some((attempt) => attempt.source === 'env' && attempt.code === 'INSIDE_INSTALL_DIR'),
    `大小写/正斜杠变体仍应判定 INSIDE_INSTALL_DIR: ${JSON.stringify(variant.attempts)}`)

  const namespaced = path.toNamespacedPath(envInside).toUpperCase()
  const namespacedVariant = await resolveGatewayRuntime({ ...base, env: { DSH_REMOTE_NODE: namespaced, PATH: outsideDir } })
  assert.equal(namespacedVariant.source, 'path')
  assert.ok(namespacedVariant.attempts.some((attempt) => attempt.source === 'env' && attempt.code === 'INSIDE_INSTALL_DIR'),
    `\\\\?\\ 前缀候选仍应判定 INSIDE_INSTALL_DIR: ${JSON.stringify(namespacedVariant.attempts)}`)

  // desktopHost=false 时同一路径允许使用（边界只在桌面宿主下生效）。
  const notDesktop = await resolveGatewayRuntime({
    ...base, desktopHost: false, env: { DSH_REMOTE_NODE: envInside },
  })
  assert.equal(notDesktop.source, 'env')
  assert.equal(notDesktop.executable, envInside)
  assert.equal(notDesktop.warning, '')
})

// ---------------------------------------------------------------------------
// 5. 同版本既有副本复用，不调用 copyRuntime
// ---------------------------------------------------------------------------
test('同版本桌面运行时副本已存在时复用且不调用 copyRuntime', async (t) => {
  const box = makeBox(t, 'reuse', { hostInside: true })
  const sourceNode = writeFake(box.sourceNode)
  const target = box.targetNode()
  writeFake(target, 'fake-existing-runtime')
  const probe = createFakeProbe({
    [sourceNode]: version(RUNTIME_VERSION),
    [target]: version(RUNTIME_VERSION),
    [box.hostExec]: version(HOST_VERSION),
  })
  const copyRuntime = createFakeCopyRuntime(() => {
    throw new Error('同版本副本已存在时不应调用 copyRuntime')
  })
  const log = captureLog()
  const result = await resolveGatewayRuntime({
    env: {}, home: box.home, execPath: box.hostExec, platform: WIN32, desktopHost: true,
    probe, copyRuntime, log: log.fn,
  })
  assert.equal(result.source, 'desktop-runtime')
  assert.equal(result.executable, target)
  assert.equal(result.version, RUNTIME_VERSION)
  assert.equal(result.major, RUNTIME_MAJOR)
  assert.ok(result.copy, '复用已有副本时 copy 也必须非空')
  assert.equal(result.copy.reused, true)
  assert.equal(result.copy.target, target)
  assert.equal(result.copy.version, RUNTIME_VERSION)
  assert.equal(copyRuntime.calls.length, 0, 'CAPTURE: copyRuntime 不得被调用')
  assert.ok(probe.calls.some((file) => normalizePath(file) === normalizePath(target)),
    '应探测目标副本以判断版本是否可复用')
  const chosen = result.candidates.find((candidate) => normalizePath(candidate.executable) === normalizePath(target))
  assert.ok(chosen, `candidates 应包含复用的目标副本: ${JSON.stringify(result.candidates)}`)
  assert.equal(chosen.reused, true)
  assert.equal(chosen.source, 'desktop-runtime')
  assert.equal(chosen.insideInstallDir, false, 'home 下的副本不在安装目录内')
})

// ---------------------------------------------------------------------------
// 6. 版本变化: 复制新版本并保留旧副本
// ---------------------------------------------------------------------------
test('桌面运行时版本变化时复制新版本并保留旧副本', async (t) => {
  const box = makeBox(t, 'version-change', { hostInside: true })
  const sourceNode = writeFake(box.sourceNode)
  const oldTarget = box.targetNode('22.0.0')
  const newTarget = box.targetNode()
  writeFake(oldTarget, 'fake-old-runtime')
  const probe = createFakeProbe({
    [sourceNode]: version(RUNTIME_VERSION),
    [oldTarget]: version('22.0.0', 22),
    [box.hostExec]: version(HOST_VERSION),
  })
  const copyRuntime = createFakeCopyRuntime((source, destination) => {
    writeFake(destination, 'fake-copied-runtime')
    probe.set(destination, version(RUNTIME_VERSION))
    return { ok: true, bytes: Buffer.byteLength('fake-copied-runtime') }
  })
  const log = captureLog()
  const result = await resolveGatewayRuntime({
    env: {}, home: box.home, execPath: box.hostExec, platform: WIN32, desktopHost: true,
    probe, copyRuntime, log: log.fn,
  })
  assert.equal(result.source, 'desktop-runtime')
  assert.equal(result.executable, newTarget)
  assert.equal(result.version, RUNTIME_VERSION)
  assert.equal(copyRuntime.calls.length, 1, '版本不一致时应调用一次 copyRuntime')
  assert.equal(copyRuntime.calls[0].source, sourceNode)
  assert.equal(copyRuntime.calls[0].target, newTarget)
  assert.ok(fs.existsSync(oldTarget), '旧版本副本必须保留（升级后可回滚/清理）')
  assert.ok(fs.existsSync(newTarget), '新版本副本必须写入')
  assert.ok(result.copy, 'copy 必须非空')
  assert.equal(result.copy.reused, false)
  assert.equal(result.copy.target, newTarget)
  assert.equal(result.copy.version, RUNTIME_VERSION)
  assert.ok(typeof result.copy.bytes === 'number' && result.copy.bytes > 0,
    `copy.bytes 应为正数: ${JSON.stringify(result.copy)}`)
})

// ---------------------------------------------------------------------------
// 7. 复制失败回退 host 并显式警告
// ---------------------------------------------------------------------------
test('copyRuntime 失败时回退 host 并给出 DSH 更新警告', async (t) => {
  const box = makeBox(t, 'copy-fail', { hostInside: true })
  writeFake(box.sourceNode)
  const probe = createFakeProbe({
    [box.sourceNode]: version(RUNTIME_VERSION),
    [box.hostExec]: { ok: false, code: 'EPERM', detail: 'spawn EPERM' },
  })
  const copyRuntime = createFakeCopyRuntime(() => ({ ok: false, error: 'EPERM' }))
  const log = captureLog()
  const result = await resolveGatewayRuntime({
    env: {}, home: box.home, execPath: box.hostExec, platform: WIN32, desktopHost: true,
    probe, copyRuntime, log: log.fn,
  })
  assert.equal(result.source, 'host')
  assert.equal(result.executable, box.hostExec)
  assert.equal(result.installDir, box.installDir)
  assert.equal(result.insideInstallDir, true)
  assert.ok(result.warning.length > 0, 'insideInstallDir=true 时 warning 必须非空')
  assert.match(result.warning, /DSH 更新可能失败/)
  assert.equal(result.copy, null)
  assert.equal(result.version, '', 'host 探测失败时 version 应为空串')
  assert.equal(typeof result.major, 'number')
  assert.ok(result.attempts.some((attempt) => attempt.source === 'desktop-runtime' && attempt.ok === false && attempt.code === 'COPY_FAILED'),
    `复制失败应记录 COPY_FAILED: ${JSON.stringify(result.attempts)}`)
  const last = result.candidates.at(-1)
  assert.equal(last.source, 'host')
  assert.equal(last.valid, false, 'host 探测失败时候选 valid=false，但仍被接受')
})

// ---------------------------------------------------------------------------
// 8. 无任何可用候选时显式回退 host + 日志
// ---------------------------------------------------------------------------
test('无 env/PATH/桌面运行时源时显式回退 host 并记录警告与跳过原因', async (t) => {
  const box = makeBox(t, 'host-fallback', { hostInside: true })
  const probe = createFakeProbe({ [box.hostExec]: version(HOST_VERSION) })
  const log = captureLog()
  const result = await resolveGatewayRuntime({
    env: {}, home: box.home, execPath: box.hostExec, platform: WIN32, desktopHost: true,
    probe, copyRuntime: createFakeCopyRuntime(), log: log.fn,
  })
  assert.equal(result.source, 'host')
  assert.equal(result.executable, box.hostExec)
  assert.equal(result.version, HOST_VERSION)
  assert.equal(result.major, HOST_MAJOR)
  assert.equal(result.insideInstallDir, true)
  assert.ok(result.warning, 'insideInstallDir=true 时 warning 必须非空')
  assert.match(result.warning, /DSH 更新可能失败/)
  const last = result.candidates.at(-1)
  assert.equal(last.source, 'host')
  assert.equal(last.executable, box.hostExec)
  assert.equal(last.insideInstallDir, true)
  assert.ok(result.attempts.some((attempt) => attempt.source === 'desktop-runtime' && attempt.code === 'SOURCE_MISSING'),
    `桌面运行时缺失应记录 SOURCE_MISSING: ${JSON.stringify(result.attempts)}`)
  assert.ok(log.lines.some((line) => /DSH 更新可能失败/.test(line)), `log 必须记录警告行: ${JSON.stringify(log.lines)}`)
  const skipLines = log.lines.filter((line) => line.includes(SKIP_MARK))
  assert.ok(skipLines.length >= 1, `log 必须包含"${SKIP_MARK}"行: ${JSON.stringify(log.lines)}`)
  for (const attempt of result.attempts.filter((item) => item.ok === false && item.source !== 'host')) {
    assertSkipLogged(skipLines, attempt)
  }
})

// ---------------------------------------------------------------------------
// 9. 默认探测集成（不注入 probe/copyRuntime）
// ---------------------------------------------------------------------------
test('默认探测集成: 真实 process.execPath 与 PATH 返回可用解释器', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-runtime-default-'))
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }) } catch {}
  })
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const log = captureLog()
  const result = await resolveGatewayRuntime({
    env: { PATH: process.env.PATH }, home,
    execPath: process.execPath, platform: process.platform, desktopHost: false,
    log: log.fn,
  })
  assert.ok(fs.existsSync(result.executable), `executable 必须真实存在: ${result.executable}`)
  assert.ok(result.major >= 18, `默认解释器主版本应 >=18: ${result.version}`)
  assert.ok(result.source === 'path' || result.source === 'host',
    `默认探测来源应为 path 或 host: ${result.source}`)
  assert.match(result.version, /^\d+\.\d+\.\d+$/)
  assert.equal(result.insideInstallDir, false)
  assert.equal(result.warning, '')
  assert.equal(result.copy, null)
})

// ---------------------------------------------------------------------------
// 10. 拒绝候选的跳过日志包含 code/detail
// ---------------------------------------------------------------------------
test('log 为每个被拒候选记录跳过原因(code/detail)', async (t) => {
  const box = makeBox(t, 'log-codes', { hostInside: true })
  const missingEnv = path.join(box.root, 'missing-env', 'node.exe')
  const probe = createFakeProbe({
    [box.hostExec]: { ok: false, code: 'EPERM', detail: 'spawn EPERM' },
  })
  const log = captureLog()
  const result = await resolveGatewayRuntime({
    env: { DSH_REMOTE_NODE: missingEnv }, home: box.home,
    execPath: box.hostExec, platform: WIN32, desktopHost: true,
    probe, copyRuntime: createFakeCopyRuntime(), log: log.fn,
  })
  assert.equal(result.source, 'host')
  for (const code of ['MISSING', 'NOT_FOUND', 'SOURCE_MISSING']) {
    assert.ok(attemptCodes(result).includes(code),
      `attempts 应包含 ${code}: ${JSON.stringify(result.attempts)}`)
  }
  const rejected = result.attempts.filter((attempt) => attempt.ok === false && attempt.source !== 'host')
  assert.ok(rejected.length >= 3, `应至少记录 3 个被拒候选: ${JSON.stringify(result.attempts)}`)
  const skipLines = log.lines.filter((line) => line.includes(SKIP_MARK))
  assert.ok(skipLines.length >= rejected.length,
    `跳过日志行数不足: ${skipLines.length} < ${rejected.length} (${JSON.stringify(skipLines)})`)
  for (const attempt of rejected) assertSkipLogged(skipLines, attempt)
})

// ---------------------------------------------------------------------------
// 11. env/PATH 为空 + 不存在的 execPath: 不抛错且返回稳定对象
// ---------------------------------------------------------------------------
test('env/PATH 为空且 execPath 不存在时返回稳定对象且不抛错', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-runtime-empty-'))
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }) } catch {}
  })
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const bogusExec = path.join(root, 'missing-node', 'node.exe')
  const log = captureLog()
  const result = await resolveGatewayRuntime({
    env: {}, home, execPath: bogusExec, platform: WIN32, desktopHost: false, log: log.fn,
  })
  assert.equal(typeof result, 'object')
  assert.equal(result.executable, bogusExec)
  assert.equal(result.source, 'host')
  assert.equal(result.installDir, path.resolve(path.dirname(bogusExec)))
  assert.equal(result.desktopHost, false)
  assert.equal(result.insideInstallDir, false)
  assert.equal(result.warning, '')
  assert.equal(result.version, '')
  assert.equal(typeof result.major, 'number')
  assert.equal(result.copy, null)
  assert.ok(Array.isArray(result.candidates))
  assert.ok(Array.isArray(result.attempts))
  assert.ok(attemptCodes(result).includes('NOT_FOUND'), 'PATH 为空应记录 NOT_FOUND')
  const last = result.candidates.at(-1)
  assert.equal(last.source, 'host')
  assert.equal(last.executable, bogusExec)
  assert.equal(last.valid, false)
  for (const key of ['executable', 'source', 'version']) assert.equal(typeof last[key], 'string')
  assert.equal(typeof last.major, 'number')
  for (const key of ['insideInstallDir', 'reused', 'valid']) assert.equal(typeof last[key], 'boolean')
})

test('目录外的 junction 指向安装目录内时拒绝，复制目标的父目录也必须真实位于安装目录外', async t => {
  const box = makeBox(t, 'junction')
  writeFake(box.sourceNode)
  const alias = path.join(box.root, 'outside-node')
  fs.symlinkSync(path.dirname(box.sourceNode), alias, process.platform === 'win32' ? 'junction' : 'dir')
  const probe = createFakeProbe({ [box.sourceNode]: version(RUNTIME_VERSION), [box.hostExec]: version(HOST_VERSION) })
  const copyRuntime = createFakeCopyRuntime((_source, target) => {
    writeFake(target); probe.set(target, version(RUNTIME_VERSION)); return { ok: true }
  })
  const options = { home: box.home, execPath: box.hostExec, platform: WIN32, desktopHost: true, probe, copyRuntime, log() {} }
  const linked = await resolveGatewayRuntime({ ...options, env: { DSH_REMOTE_NODE: path.join(alias, 'node.exe') } })
  assert.equal(linked.source, 'desktop-runtime')
  assert.ok(linked.attempts.some(row => row.source === 'env' && row.code === 'INSIDE_INSTALL_DIR'))
  const insideHome = path.join(box.installDir, 'user-home')
  fs.mkdirSync(insideHome)
  const aliasHome = path.join(box.root, 'outside-home')
  fs.symlinkSync(insideHome, aliasHome, process.platform === 'win32' ? 'junction' : 'dir')
  const unsafe = await resolveGatewayRuntime({ ...options, home: aliasHome, env: {} })
  assert.equal(unsafe.source, 'host')
  assert.ok(unsafe.attempts.some(row => row.source === 'desktop-runtime' && row.code === 'INSIDE_INSTALL_DIR'))
  assert.equal(fs.existsSync(path.join(insideHome, '.dsh-remote')), false, '拒绝之前不得在安装目录中创建副本')
})

// 执行真实启动/状态/自愈控制流；仅替换 OS 边界，避免为失败候选启动真实常驻进程。
function runtimeHarness(plan, { initialHealth, report, outcome = () => 'ready' } = {}) {
  const source = fs.readFileSync(PLUGIN, 'utf8')
  const spawned = [], stopped = [], logs = []
  const state = { health: initialHealth || { running: false }, report }
  const upstream = 'http://127.0.0.1:3080', version = '0.8.0'
  let nextPid = 1000
  const context = vm.createContext({
    process, Date, Number, String, isAbsolute: path.isAbsolute, resolve: path.resolve,
    dirname: path.dirname, basename: path.basename, join: path.join, realpathSync: fs.realpathSync,
    resolveGatewayRuntime: async () => plan,
    gatewayRunning: async () => state.health,
    proxyGateway: async () => ({ status: 200, json: { ok: true, gatewayRuntime: state.report } }),
    gatewayAutostart: () => true, refreshDshUpstreamCookie: async () => {},
    logGateway: line => logs.push(line), insideInstallDirWarning: () => 'DSH 更新可能失败',
    upstreamUrlForListener: () => upstream, dshListen: {}, version,
    existsSync: () => true, GATEWAY_SCRIPT: 'isolated-gateway.cjs',
    homedir: () => os.tmpdir(), mkdirSync() {}, openSync: () => 1, closeSync() {},
    readGatewayPort: () => 12345, readGatewayHost: () => '127.0.0.1', portInUse: async () => false,
    runExit: async () => 1, gatewaySystemdEnvArgs: () => [], writeGatewayPid() {}, setGatewayEnabled() {},
    sleep: () => new Promise(resolve => setImmediate(resolve)), setTimeout: callback => queueMicrotask(callback),
    killGateway: async health => { stopped.push(health.pid); state.health = { running: false }; return true },
    spawn: executable => {
      spawned.push(executable)
      const child = new EventEmitter(); child.pid = ++nextPid; child.unref = () => {}
      const result = outcome(executable)
      if (result === 'exit') setImmediate(() => child.emit('exit', 1, null))
      else if (result === 'ready') {
        state.health = { running: true, pid: child.pid + 10000, upstream, version }
        state.report = { pid: state.health.pid, supervisorPid: child.pid, executable, version: RUNTIME_VERSION }
      }
      return child
    },
  })
  const paths = source.slice(source.indexOf('function normalizeNodeVersion('), source.indexOf('function desktopBundledNodePath('))
  const controls = source.slice(source.indexOf('function gatewayRuntimeSummary('), source.indexOf('// ---------- 统计事件投递'))
  vm.runInContext(paths + controls, context)
  return { spawned, stopped, logs, state,
    start: () => vm.runInContext('startGateway()', context),
    ensure: () => vm.runInContext('ensureGateway()', context),
    status: () => vm.runInContext('gatewayRuntimeForStatus()', context),
  }
}

async function fallbackPlan(t) {
  const box = makeBox(t, 'launch-fallback')
  const external = writeFake(path.join(box.root, 'external', 'node.exe'))
  writeFake(box.sourceNode)
  const probe = createFakeProbe({ [external]: version(RUNTIME_VERSION), [box.sourceNode]: version(RUNTIME_VERSION), [box.hostExec]: version(HOST_VERSION) })
  const copyRuntime = createFakeCopyRuntime((_source, target) => {
    writeFake(target); probe.set(target, version(RUNTIME_VERSION)); return { ok: true }
  })
  const plan = await resolveGatewayRuntime({ env: { DSH_REMOTE_NODE: external }, home: box.home,
    execPath: box.hostExec, platform: WIN32, desktopHost: true, probe, copyRuntime, log() {} })
  return { box, external, plan, copyRuntime }
}

test('外部解释器通过 -v 但启动即死时，按需准备内置副本再尝试宿主', async t => {
  const { box, external, plan, copyRuntime } = await fallbackPlan(t)
  assert.equal(copyRuntime.calls.length, 0, '外部候选可用时不提前复制')
  const h = runtimeHarness(plan, { outcome: executable => executable === external ? 'exit' : 'ready' })
  const result = await h.start()
  assert.deepEqual(h.spawned, [external, box.targetNode()])
  assert.equal(result.runtime.source, 'desktop-runtime')
  assert.equal(result.runtime.insideInstallDir, false)
  assert.equal(copyRuntime.calls.length, 1)
  assert.equal(result.runtime.copy.target, box.targetNode())
})

test('所有外部候选启动失败后，宿主回退的两个目录标记和告警一致且不反复重启', async t => {
  const { box, plan } = await fallbackPlan(t)
  const h = runtimeHarness(plan, { outcome: executable => executable === box.hostExec ? 'ready' : 'exit' })
  const result = await h.start()
  assert.equal(h.spawned.length, 3)
  assert.equal(result.runtime.insideInstallDir, true)
  assert.equal(result.runtime.runtimeInsideInstallDir, true)
  assert.match(result.runtime.warning, /DSH 更新可能失败/)
  await h.ensure()
  assert.equal(h.stopped.length, 0, '当前进程已尝试并回退的网关不能反复迁移')
})

test('同版本遗留宿主网关显示实际解释器，并经认证关闭路径迁移到外部候选', async t => {
  const { box, external, plan } = await fallbackPlan(t)
  const health = { running: true, pid: 2000, version: '0.8.0', upstream: 'http://127.0.0.1:3080' }
  const h = runtimeHarness(plan, { initialHealth: health, report: { pid: health.pid, executable: box.hostExec, version: HOST_VERSION } })
  const before = await h.status()
  assert.equal(before.executable, box.hostExec)
  assert.equal(before.insideInstallDir, true)
  await h.ensure()
  assert.deepEqual(h.stopped, [health.pid])
  assert.deepEqual(h.spawned, [external])
  assert.equal((await h.status()).executable, external)
})

test('不支持运行时查询的旧网关显示待确认，不能拿计划路径冒充；换 PID 后不复用旧状态', async t => {
  const { plan } = await fallbackPlan(t)
  const h = runtimeHarness(plan, { initialHealth: { running: true, pid: 2000 } })
  const unknown = await h.status()
  assert.equal(unknown.source, 'unknown')
  assert.equal(unknown.executable, '')
  assert.equal(unknown.insideInstallDir, null)
  h.state.report = { pid: 2000, executable: plan.executable, version: RUNTIME_VERSION }
  assert.equal((await h.status()).source, 'env')
  h.state.health = { running: true, pid: 2001 }
  assert.equal((await h.status()).source, 'unknown')
  h.state.health = { running: false }
  assert.equal(await h.status(), null)
})

test('慢启动返回 pending 后仍不重复拉起；稍后就绪的宿主回退不会被误判为遗留实例', async t => {
  const { box, external, plan } = await fallbackPlan(t)
  const h = runtimeHarness(plan, { outcome: executable => executable === box.hostExec ? 'pending' : 'exit' })
  assert.equal((await h.start()).pending, true)
  assert.deepEqual(h.spawned, [external, box.targetNode(), box.hostExec])
  h.state.health = { running: true, pid: 3000, version: '0.8.0', upstream: 'http://127.0.0.1:3080' }
  h.state.report = { pid: 3000, executable: box.hostExec, version: HOST_VERSION, supervisorPid: 1003 }
  await h.ensure()
  assert.equal(h.stopped.length, 0)
  assert.equal((await h.status()).runtimeInsideInstallDir, true)
})

// ---------------------------------------------------------------------------
// 12. 可选集成: 通过插件管理 API 真实拉起网关（空 PATH + 缺失 DSH_REMOTE_NODE）。
//     直接使用工作区里的真实 packages/plugin/gateway.cjs，不复制插件目录；
//     仅创建临时 HOME，结束时认证停止网关并清理。
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function readPidFile(file) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim())
    return Number.isInteger(pid) && pid > 1 ? pid : null
  } catch { return null }
}

async function requestJson(url, options, timeout) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout || 5000) })
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch {}
  return { status: response.status, ok: response.ok, body, text }
}

async function gatewayHealth(gatewayBase) {
  try {
    const response = await fetch(`${gatewayBase}/health`, { signal: AbortSignal.timeout(600) })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

test('集成: 插件按解析结果真实拉起网关并记录解释器回退', {
  timeout: 60000,
  skip: fs.existsSync(GATEWAY_SCRIPT) ? false : 'packages/plugin/gateway.cjs 不存在',
}, async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-runtime-integration-'))
  const configDir = path.join(tmpHome, '.dsh-remote')
  const emptyBin = path.join(tmpHome, 'empty-bin')
  fs.mkdirSync(configDir, { recursive: true })
  fs.mkdirSync(emptyBin)
  const gatewayPort = await getFreePort()
  const token = 'gateway-runtime-integration-token'
  const gatewayBase = `http://127.0.0.1:${gatewayPort}`
  const missingEnvNode = 'C:\\definitely-missing\\node.exe'

  const envKeys = [
    'HOME', 'USERPROFILE', 'PATH', 'DSH_REMOTE_AUTOSTART', 'DSH_REMOTE_GATEWAY',
    'DSH_REMOTE_GATEWAY_PORT', 'DSH_REMOTE_GATEWAY_HOST', 'DSH_REMOTE_NODE',
    'DSH_REMOTE_FS_ROOT', 'DSH_REMOTE_DSH_COOKIE_FILE', 'TOKEN', 'TOKEN_FILE',
    'DSH_REMOTE_TOKEN', 'UPDATE_CHECK_URL', 'UPDATE_INTERVAL_MS', 'UPDATE_PROXY',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'HOST',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY',
  ]
  const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    PATH: emptyBin,
    DSH_REMOTE_AUTOSTART: '0',
    DSH_REMOTE_GATEWAY: gatewayBase,
    DSH_REMOTE_GATEWAY_PORT: String(gatewayPort),
    DSH_REMOTE_GATEWAY_HOST: '127.0.0.1',
    DSH_REMOTE_NODE: missingEnvNode,
    DSH_REMOTE_FS_ROOT: tmpHome,
    DSH_REMOTE_DSH_COOKIE_FILE: path.join(configDir, 'dsh-upstream.cookie'),
    TOKEN: token,
    DSH_REMOTE_TOKEN: token,
    UPDATE_CHECK_URL: 'http://127.0.0.1:1/update',
    UPDATE_INTERVAL_MS: '3600000',
    UPDATE_PROXY: '',
    NO_PROXY: '*',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
  })
  delete process.env.HOST
  delete process.env.TOKEN_FILE
  for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY']) delete process.env[key]

  let route = null
  let serverBase = ''
  const disposers = []
  const ctx = {
    connection: {},
    webServer: {
      host: '127.0.0.1',
      port: 0,
      register(definition) {
        route = definition
        return () => { route = null }
      },
    },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    skills: {
      registerProvider(create) {
        create({ signal: new AbortController().signal, invalidate() {} })
        return () => {}
      },
    },
    on() { return () => {} },
    agents: { list() { return [] }, get() {}, async resume() { return null } },
    commands: { async list() { return [] }, async execute() {} },
  }
  const server = http.createServer((req, res) => {
    if (!route || !req.url.startsWith(route.path)) {
      res.writeHead(404)
      res.end('not mounted')
      return
    }
    Promise.resolve(route.handler(req, res)).catch((error) => {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(error?.message || error))
    })
  })

  async function stopGatewayAndWait() {
    try {
      await requestJson(`${serverBase}/remote/admin/api/gateway`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      }, 8000)
    } catch {}
    for (let i = 0; i < 40; i++) {
      if (!await gatewayHealth(gatewayBase)) return
      await sleep(150)
    }
    // 优雅关闭失败: 先终止 supervisor（它会连带终止 worker），再终止 pid 文件记录的进程。
    let supervisorPid = null
    try {
      supervisorPid = Number(JSON.parse(fs.readFileSync(
        path.join(configDir, `gateway-supervisor-${gatewayPort}.json`), 'utf8')).pid) || null
    } catch {}
    for (const pid of [supervisorPid, readPidFile(path.join(configDir, 'plugin-gateway.pid'))]) {
      if (pid && pid > 1) { try { process.kill(pid, 'SIGTERM') } catch {} }
    }
    for (let i = 0; i < 30; i++) {
      if (!await gatewayHealth(gatewayBase)) return
      await sleep(150)
    }
  }

  t.after(async () => {
    try { await stopGatewayAndWait() } catch {}
    for (const dispose of disposers.reverse()) { try { dispose() } catch {} }
    await new Promise((resolve) => server.close(resolve))
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    // Windows 上子进程退出后才释放目录句柄。
    for (let i = 0; i < 20; i++) {
      try { fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 2 }); return } catch { await sleep(100) }
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  ctx.webServer.port = server.address().port
  serverBase = `http://127.0.0.1:${ctx.webServer.port}`

  const plugin = await import(pathToFileURL(PLUGIN).href + `?gateway-runtime-integration=${Date.now()}`)
  plugin.apply(ctx)
  assert.equal(route?.path, '/remote')

  const start = await requestJson(`${serverBase}/remote/admin/api/gateway`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'start' }),
  }, 20000)
  assert.equal(start.status, 200)
  assert.equal(start.body?.ok, true, `启动响应异常: ${start.text}`)

  let health = null
  for (let i = 0; i < 40; i++) {
    health = await gatewayHealth(gatewayBase)
    if (health) break
    await sleep(150)
  }
  assert.ok(health, `网关未通过插件启动: ${start.text}`)
  assert.ok(health.pid > 1)
  assert.equal((await fetch(`${gatewayBase}/admin/api/runtime`)).status, 401)
  const runtimeResponse = await requestJson(`${gatewayBase}/admin/api/runtime`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(runtimeResponse.body.gatewayRuntime.pid, health.pid)
  assert.equal(normalizePath(runtimeResponse.body.gatewayRuntime.executable), normalizePath(process.execPath))
  assert.equal((await fetch(`${gatewayBase}/admin/api/runtime`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status, 405)
  const stateResponse = await requestJson(`${serverBase}/remote/admin/api/state`)
  assert.equal(stateResponse.body.gatewayRuntime.pid, health.pid)
  assert.equal(normalizePath(stateResponse.body.gatewayRuntime.executable), normalizePath(process.execPath))

  const logText = fs.readFileSync(path.join(configDir, 'plugin-gateway.log'), 'utf8')
  assert.match(logText, /网关解释器候选跳过: env .*definitely-missing/i,
    `日志缺少被跳过的 DSH_REMOTE_NODE 候选: ${logText}`)
  assert.match(logText, /网关解释器兜底: host -> /,
    `日志缺少 host 回退候选: ${logText}`)

  const stop = await requestJson(`${serverBase}/remote/admin/api/gateway`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'stop' }),
  }, 10000)
  assert.equal(stop.status, 200)
  assert.equal(stop.body?.ok, true, `停止响应异常: ${stop.text}`)
})
