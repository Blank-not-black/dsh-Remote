/* Profile-scoped plugin management. No shell input, dependencies or client-selected paths. */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, copyFileSync, cpSync, unlinkSync, realpathSync, openSync, closeSync } from 'node:fs'
import { dirname, basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { prepareReleasePlan, profileRevision, backupTransaction, writeWorkspace, mergeReleaseRules, releasePolicy, verifyInstalled, treeDigest, restoreTransaction, canonicalPath } from './plugin-transaction.mjs'
import { createMarketAdapter, createReadmeReader } from './market.mjs'

const REGISTRY = 'https://registry.npmjs.org'
const SELF = fileURLToPath(import.meta.url)
const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?![\s\S])/
const versionPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?(?![\s\S])/
const idPattern = /^[a-zA-Z0-9-]{16,80}(?![\s\S])/
const read = path => JSON.parse(readFileSync(path, 'utf8'))
function atomic(path, value) {
  const tmp = path + '.' + process.pid + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const protectedPackage = name => name === 'dsh-remote-plugin' || name.startsWith('@deepseek-ai/')
const revision = path => createHash('sha256').update(readFileSync(path)).digest('hex')
function adapterInterfaces(ctx) {
  // Shape checks only: never query balances, read content or activate sessions.
  const result = {}
  for (const [id, name, method] of [['cost', 'costMeter', 'getState'], ['tasks', 'taskBoard', 'snapshot']]) {
    try { const service = ctx.get?.(name); result[id] = { supported: service ? typeof service[method] === 'function' : null } }
    catch { result[id] = { supported: null } }
  }
  return result
}
// A detached worker can replace/delete its ledger between two manager reads.
// Windows sharing violations are uncertain ownership, never proof of death.
function ownershipText(path) {
  try { return readFileSync(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return null
    if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) return undefined
    throw error
  }
}
const ownershipPending = '任务锁正在更新或暂时无法读取，已保留锁；请稍后刷新。'

let windowsProbe
function windowsProcessIds() {
  // Windows can return EPERM for an exited PID. Enumerate OS processes instead;
  // failure or malformed output must never be interpreted as an empty list.
  if (!windowsProbe) windowsProbe = new Promise((resolveIds, reject) => {
    execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; ConvertTo-Json -Compress -InputObject @(Get-Process -ErrorAction Stop | Select-Object -ExpandProperty Id)'],
      { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(error)
        try {
          const ids = JSON.parse(stdout.replace(/^\uFEFF/, ''))
          if (!Array.isArray(ids) || !ids.length || !ids.every(Number.isInteger)) throw new Error('Invalid process list')
          resolveIds(new Set(ids))
        } catch (error) { reject(error) }
      })
  }).finally(() => { windowsProbe = null })
  return windowsProbe
}

export async function probeProcesses(pids, runtime = process, enumerate = windowsProcessIds) {
  const states = new Map(), uncertain = []
  for (const pid of new Set(pids.filter(pid => Number.isInteger(pid) && pid > 0))) {
    try { runtime.kill(pid, 0); states.set(pid, 'alive') }
    catch (error) {
      states.set(pid, error.code === 'ESRCH' ? 'dead' : 'unknown')
      if (error.code === 'EPERM' && runtime.platform === 'win32') uncertain.push(pid)
    }
  }
  if (uncertain.length) {
    try {
      const ids = await enumerate()
      for (const pid of uncertain) states.set(pid, ids.has(pid) ? 'alive' : 'dead')
    } catch { /* Keep unknown on timeout, denied access or unavailable OS query. */ }
  }
  return states
}

// Never clear a live worker or its package-manager child. PID reuse fails closed.
async function recoverDeadLock(storage, probe = probeProcesses) {
  const path = join(storage, 'lock.json')
  const original = ownershipText(path)
  if (original === null) return
  if (original === undefined) return ownershipPending
  const owner = JSON.parse(original)
  if (!idPattern.test(owner.id || '')) throw fail('插件任务锁损坏，请在主机检查', 409)
  const launchPath = join(storage, 'launch-' + owner.id + '.json')
  const launchRecord = ownershipText(launchPath)
  if (launchRecord === undefined) return ownershipPending
  const workerPid = owner.workerPid || (launchRecord ? JSON.parse(launchRecord).pid : null)
  const pids = workerPid ? [workerPid, owner.cliPid] : [owner.launcherPid, owner.cliPid]
  if (pids.some(pid => pid != null && (!Number.isSafeInteger(pid) || pid <= 0))) return '任务锁进程信息损坏，已保留锁；请在主机检查。'
  const states = await probe(pids)
  const currentOwner = ownershipText(path), currentLaunch = ownershipText(launchPath)
  if (currentOwner === undefined || currentLaunch === undefined) return ownershipPending
  if (currentOwner !== original || currentLaunch !== launchRecord) return
  if ([...states.values()].some(state => state !== 'dead')) {
    return [...states.values()].includes('unknown')
      ? '无法确认任务进程是否已退出，已保留锁；请在主机检查进程权限与操作记录。'
      : '主机任务进程仍在运行，其他修改暂不可用；可展开操作记录查看日志。'
  }
  if (!workerPid && (!owner.launcherPid || !Number.isFinite(owner.createdAt) || Date.now() - owner.createdAt < 30000)) return
  const jobPath = join(storage, 'job-' + owner.id + '.json')
  if (existsSync(jobPath)) {
    const job = read(jobPath)
    if (['queued', 'running'].includes(job.phase)) {
      job.phase = 'interrupted'; job.endedAt = Date.now(); job.restartRequired = true
      job.message = '任务进程已退出，已解除锁定。文件可能已改变，请核对插件状态；未执行自动回滚。'
      if (job.transactionStarted && existsSync(join(storage, 'backup-' + owner.id, 'transaction.json'))) {
        try { job.recoveryState = { revision: profileRevision(dirname(storage)), installed: treeDigest(join(dirname(storage), 'node_modules')) } }
        catch { /* Incomplete evidence requires host recovery, never a blind restore. */ }
      }
      atomic(jobPath, job)
    }
  }
  // All reads/writes here are synchronous; recheck ownership before unlinking.
  if (ownershipText(path) === original) {
    copyFileSync(path, join(storage, 'recovered-lock-' + owner.id + '.json'))
    unlinkSync(path)
  }
}

async function profileLock(dir, probe = probeProcesses) {
  const path = join(dir, 'package.json.lock')
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8'), text = raw.trim()
  const pid = /^\d+$/.test(text) ? Number(text) : null
  if (!Number.isSafeInteger(pid) || pid <= 0) return { path, raw, state: 'unknown', message: 'DSH 配置锁格式无法识别，请在主机检查 package.json.lock。' }
  const state = (await probe([pid])).get(pid) || 'unknown'
  if (!existsSync(path)) return null
  if (readFileSync(path, 'utf8') !== raw) return { state: 'unknown', message: 'DSH 配置锁已变化，请刷新后重试。' }
  return { path, raw, pid, state, message: state === 'dead'
    ? '检测到已退出进程遗留的 DSH 配置锁；下一次操作会备份并回收。'
    : state === 'alive' ? 'DSH 配置被进程 ' + pid + ' 占用，请等待主机操作结束后重试。'
      : '无法确认 DSH 配置锁进程 ' + pid + ' 是否已退出，请在主机检查；锁已保留。' }
}

export function detectProfile(ctx, cli = process.argv[1], runtime = process) {
  try {
    const dir = realpathSync(fileURLToPath(ctx.root?.baseUrl || ctx.baseUrl))
    const manifest = read(join(dir, 'package.json'))
    if (basename(dirname(dir)) !== 'profiles' || !Array.isArray(manifest.dsh?.profile?.bundles)) return null
    const name = basename(dir)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*(?![\s\S])/.test(name)) return null
    const base = { dir, name, home: dirname(dirname(dir)), cli: null }
    // Desktop reserves this profile for its installation-owned carrier CLI.
    // Bind to the host that booted this root, never a global CLI or PATH entry.
    if (name === 'desktop') {
      try {
        const entry = realpathSync(cli), hostRoot = dirname(dirname(entry))
        const host = read(join(hostRoot, 'package.json'))
        const runtimeDir = realpathSync(resolve(hostRoot, '../../..'))
        const bundled = read(join(runtimeDir, 'package.json'))
        const carrier = join(hostRoot, 'lib', 'cli.js')
        if (runtime.versions?.electron && host.name === '@deepseek-ai/dsh-desktop-host'
          && entry === realpathSync(join(hostRoot, 'lib', 'index.js'))
          && bundled.name === '@deepseek-ai/dsh-desktop-runtime' && bundled.version === host.version
          && runtimeDir === realpathSync(runtime.argv[2]) && dir === realpathSync(runtime.argv[3])
          && existsSync(carrier)) return { ...base, cli: carrier, cliMode: 'desktop' }
      } catch {}
      return base
    }
    let root
    try { root = dirname(realpathSync(cli)) } catch { return base }
    let found = null
    for (let i = 0; i < 5; i++, root = dirname(root)) {
      try { if (read(join(root, 'package.json')).name === '@deepseek-ai/dsh') { found = join(root, 'lib', 'bin.js'); break } } catch {}
    }
    return { ...base, cli: found && existsSync(found) ? found : null }
  } catch { return null }
}

async function registryJson(path, signal = AbortSignal.timeout(20000)) {
  const response = await fetch(REGISTRY + path, { signal, redirect: 'error' })
  if (!response.ok) { await response.body?.cancel(); throw fail('npm registry ' + path + ': HTTP ' + response.status, 502) }
  let raw = '', bytes = 0
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > 8 * 1024 * 1024) throw fail('Registry response too large: ' + path + ' (' + bytes + ' bytes; limit ' + 8 * 1024 * 1024 + ')', 502)
    raw += decoder.decode(chunk, { stream: true })
  }
  raw += decoder.decode()
  return JSON.parse(raw)
}

export async function pluginDetails(name, version = 'latest') {
  if (!packagePattern.test(name) || !(version === 'latest' || versionPattern.test(version))) throw fail('Invalid package or version')
  const data = await registryJson('/' + encodeURIComponent(name) + '/' + encodeURIComponent(version))
  if (data.name !== name || !versionPattern.test(data.version)) throw fail('Invalid registry metadata', 502)
  return {
    name, version: data.version, description: String(data.description || ''),
    bundle: typeof data.dsh?.bundle?.patch === 'string',
    license: typeof data.license === 'string' ? data.license : '',
    homepage: typeof data.homepage === 'string' ? data.homepage : '',
    engines: data.engines || {}, peers: data.peerDependencies || {},
    protected: protectedPackage(name), source: REGISTRY,
  }
}

const publicationCache = new Map()
// install-v1 metadata omits `time`. Validate the full JSON stream, retaining only
// top-level name/time; readmes and all-version manifests never accumulate in RAM.
function publicationProjection() {
  const stack = [], result = Object.create(null)
  let root = false, done = false, token = '', mode = '', escaped = false, unicode = 0, capture = false, retained = 0
  const invalid = () => { throw fail('Invalid npm publication metadata', 502) }
  const wanted = frame => frame.keep || stack.length === 1 && ['name', 'time'].includes(frame.key)
  function accept(kind, value) {
    const frame = stack.at(-1)
    if (kind === '}' || kind === ']') {
      if (!frame || frame.kind !== (kind === '}' ? '{' : '[') || !['first', 'end'].includes(frame.state)) invalid()
      stack.pop(); if (!stack.length) done = true
      return
    }
    if (kind === ':') { if (frame?.state !== 'colon') invalid(); frame.state = 'value'; return }
    if (kind === ',') { if (frame?.state !== 'end') invalid(); frame.state = frame.kind === '{' ? 'key' : 'value'; return }
    if (frame?.kind === '{' && ['first', 'key'].includes(frame.state)) {
      if (kind !== 'string') invalid()
      frame.key = value; frame.state = 'colon'; return
    }
    if (frame && !(frame.state === 'value' || frame.kind === '[' && frame.state === 'first')) invalid()
    if (!frame && (root || kind !== '{')) invalid()
    const keep = frame ? wanted(frame) : false
    if (keep && (stack.length === 1 && frame.key === 'time' ? kind !== '{' : kind !== 'string')) invalid()
    const container = kind === '{' || kind === '['
    const next = container ? kind === '{' ? Object.create(null) : [] : value
    if (!frame) root = true
    else {
      if (keep) {
        const target = stack.length === 1 ? result : frame.value
        if (frame.kind === '[') target.push(next)
        else { if (Object.hasOwn(target, frame.key)) invalid(); target[frame.key] = next }
      }
      frame.state = 'end'
    }
    if (container) {
      if (stack.length >= 64) invalid()
      stack.push({ kind, state: 'first', keep, value: next, key: '' })
    }
  }
  function append(char) {
    if (capture) {
      if (++retained > 1024 * 1024) throw fail('npm publication fields exceed 1048576 characters', 502)
      token += char
    }
  }
  function push(raw) {
    for (let i = 0; i < raw.length; i++) {
      const char = raw[i]
      if (mode === 'string') {
        append(char)
        if (unicode) { if (!/[a-fA-F0-9]/.test(char)) invalid(); unicode--; continue }
        if (escaped) { if (char === 'u') unicode = 4; else if (!'"\\/bfnrt'.includes(char)) invalid(); escaped = false; continue }
        if (char === '\\') { escaped = true; continue }
        if (char === '"') { accept('string', capture ? JSON.parse(token) : undefined); mode = ''; token = ''; continue }
        if (char.charCodeAt(0) < 32) invalid()
        continue
      }
      if (mode === 'scalar') {
        if (!/[\s,}\]]/.test(char)) { if (token.length >= 128) invalid(); token += char; continue }
        if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(token)) invalid()
        accept('scalar', JSON.parse(token)); mode = ''; token = ''; i--; continue
      }
      if (/^[ \r\n\t]$/.test(char)) continue
      if (done) invalid()
      if ('{}[]:,'.includes(char)) { accept(char); continue }
      if (char === '"') {
        const frame = stack.at(-1)
        capture = !!frame && (frame.kind === '{' && ['first', 'key'].includes(frame.state) ? frame.keep || stack.length === 1 : wanted(frame))
        token = ''; mode = 'string'; append(char); continue
      }
      if (!/[tfn\d-]/.test(char)) invalid()
      token = char; mode = 'scalar'
    }
  }
  return { push, finish() { if (!done || mode || stack.length) invalid(); return result } }
}
export async function publicationTimes(name, signal) {
  if (!packagePattern.test(name)) throw fail('Invalid package')
  const cached = publicationCache.get(name)
  if (cached?.until > Date.now()) return cached.value
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)
  let data, bytes = 0
  try {
    const response = await fetch(REGISTRY + '/' + encodeURIComponent(name), { signal: requestSignal, redirect: 'error', headers: { accept: 'application/json' } })
    if (!response.ok) { await response.body?.cancel(); throw fail('HTTP ' + response.status, 502) }
    const projection = publicationProjection(), decoder = new TextDecoder('utf-8', { fatal: true })
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > 64 * 1024 * 1024) throw fail('Registry response too large (' + bytes + ' bytes; limit 67108864)', 502)
      projection.push(decoder.decode(chunk, { stream: true }))
    }
    projection.push(decoder.decode()); data = projection.finish()
    if (data.name !== name || !data.time || typeof data.time !== 'object' || Array.isArray(data.time)
      || Object.values(data.time).some(value => typeof value !== 'string')) throw fail('npm 未提供可核验的发布时间', 502)
  } catch (error) {
    const reason = requestSignal.aborted ? '发布时间预检超时或已取消，不会执行安装' : error.status ? error.message : 'Registry response failed or invalid'
    throw fail('npm ' + name + ': ' + reason + ' (received ' + bytes + ' bytes)', 502)
  }
  publicationCache.set(name, { value: data.time, until: Date.now() + 5 * 60000 })
  if (publicationCache.size > 1500) publicationCache.delete(publicationCache.keys().next().value)
  return data.time
}

export function createPluginCenter(ctx, options = {}) {
  const market = createMarketAdapter(ctx), readme = createReadmeReader(options.registryJson || registryJson)
  const profile = options.profile === undefined ? detectProfile(ctx) : options.profile
  const details = options.details || pluginDetails
  const probe = options.probeProcesses || probeProcesses
  const launch = options.launch || (args => {
    const desktop = profile?.cliMode === 'desktop'
    // A self-update can replace this module's package directory. Run a private
    // snapshot from the profile ledger, with an explicit stable working dir.
    const workerFile = join(profile.dir, '.remote-plugin-center', 'worker-' + args[2] + '.mjs')
    const transactionName = 'transaction-' + args[2] + '.mjs'
    const marketName = 'market-' + args[2] + '.mjs'
    writeFileSync(join(profile.dir, '.remote-plugin-center', transactionName), readFileSync(new URL('./plugin-transaction.mjs', import.meta.url)), { flag: 'wx', mode: 0o600 })
    writeFileSync(join(profile.dir, '.remote-plugin-center', marketName), readFileSync(new URL('./market.mjs', import.meta.url)), { flag: 'wx', mode: 0o600 })
    writeFileSync(workerFile, readFileSync(SELF, 'utf8').replace("'./plugin-transaction.mjs'", JSON.stringify('./' + transactionName)).replace("'./market.mjs'", JSON.stringify('./' + marketName)), { flag: 'wx', mode: 0o600 })
    const errorLog = openSync(join(profile.dir, '.remote-plugin-center', 'worker-' + args[2] + '.log'), 'a', 0o600)
    let child
    try {
      // 这里是短命的插件事务 worker：只在插件安装/更新期间存在，不构成对 DSH 安装目录的
      // 长期占用，因此继续使用 process.execPath（桌面版会显式加 ELECTRON_RUN_AS_NODE）。
      // 若将来出现同类 Windows 文件锁（占用 DSH 安装目录导致更新失败），再统一到
      // packages/plugin/index.mjs 的 resolveGatewayRuntime()。
      child = spawn(process.execPath, [...(desktop ? ['--expose-internals'] : []), workerFile, '--worker', ...args], {
        cwd: profile.dir, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', errorLog],
        env: { ...process.env, ...(desktop ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      })
    } finally { closeSync(errorLog) }
    return new Promise((resolveLaunch, reject) => {
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); resolveLaunch(child.pid) })
    })
  })
  const manifestPath = profile && join(profile.dir, 'package.json')
  const initialRevision = profile && revision(manifestPath)
  const storage = profile && join(profile.dir, '.remote-plugin-center')
  let submitting = false
  async function preflight(body) {
    if (!profile?.cli) throw fail('当前环境只读', 409)
    if (!body || !['install', 'update', 'remove'].includes(body.action) || !packagePattern.test(body.name || '') || (body.action !== 'remove' && !versionPattern.test(body.version || ''))) throw fail('Invalid operation')
    if (protectedPackage(body.name) && !(body.action === 'update' && body.name === 'dsh-remote-plugin')) throw fail('核心插件请通过主机维护流程管理', 409)
    if (body.revision !== revision(manifestPath)) throw fail('插件列表已变化，请刷新', 409)
    const state = await inventory()
    if (state.busy || state.profileLock && state.profileLock.state !== 'dead') throw fail('已有插件任务或配置锁，请等待后重试', 409)
    const plan = await prepareReleasePlan(profile.dir, body, options.publicationTimes || publicationTimes)
    const key = createHash('sha256').update(JSON.stringify(plan) + Math.random()).digest('hex')
    mkdirSync(storage, { recursive: true, mode: 0o700 })
    atomic(join(storage, 'preflight-' + key + '.json'), plan)
    // Never return configuration text, tokens or registry credentials to the UI.
    const { workspace, ...review } = plan
    return { ok: true, plan: { ...review, key } }
  }
  async function inventory() {
    const busyReason = storage ? await recoverDeadLock(storage, probe) : ''
    let runtime = [], runtimeAvailable = false
    const loader = ctx.get?.('loader') || ctx.loader
    if (loader?.entries) {
      runtime = [...loader.entries()].filter(entry => !entry.options.group).map(entry => ({
        id: entry.id, name: entry.options.name, enabled: !entry.disabled,
        phase: ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'][entry.fiber?.state] || 'inactive',
      }))
      runtimeAvailable = true
    }
    if (!profile) return { ok: true, writable: false, reason: '无法确认当前 DSH profile；仅显示运行状态。', runtime, runtimeAvailable, items: [], operations: [] }
    const manifest = read(manifestPath)
    const bundles = manifest.dsh.profile.bundles
    const names = [...new Set([...bundles, ...Object.keys(manifest.dependencies || {})])]
    const items = names.map(name => {
      let pkg = null
      if (packagePattern.test(name)) {
        try { pkg = read(join(profile.dir, 'node_modules', ...name.split('/'), 'package.json')) } catch {}
      }
      const displayName = typeof pkg?.displayName === 'string' ? pkg.displayName : typeof pkg?.dsh?.displayName === 'string' ? pkg.dsh.displayName : name
      return { name, displayName, version: pkg?.version || '', requested: manifest.dependencies?.[name] || '',
        enabled: bundles.includes(name), bundle: !!pkg?.dsh?.bundle?.patch || bundles.includes(name),
        managed: !!manifest.dependencies?.[name] && !protectedPackage(name),
        selfUpdate: name === 'dsh-remote-plugin' && !!profile.cli,
      description: pkg?.description || '', runtime: runtime.filter(entry => entry.name === name) }
    })
    let operations = []
    if (existsSync(storage)) operations = readdirSync(storage).filter(name => /^job-[a-zA-Z0-9-]+\.json$/.test(name)).map(name => {
      try { return read(join(storage, name)) } catch { return null }
    }).filter(Boolean).sort((a, b) => b.startedAt - a.startedAt).slice(0, 20).map(publicJob)
    const lockPath = join(storage, 'lock.json')
    const ownerText = ownershipText(lockPath)
    const owner = ownerText === null ? null : ownerText === undefined ? {} : JSON.parse(ownerText)
    const legacyLock = owner && idPattern.test(owner.id || '') && !owner.launcherPid && !owner.workerPid && !owner.cliPid && !existsSync(join(storage, 'launch-' + owner.id + '.json'))
    return { ok: true, profile: profile.name, revision: revision(manifestPath), writable: !!profile.cli, adaptations: adapterInterfaces(ctx),
      reason: profile.cli ? '' : profile.name === 'desktop'
        ? '未能验证当前桌面安装的插件管理入口；仅显示状态，请检查 DSH Desktop 版本与安装完整性。'
        : '当前启动方式没有可验证的 DSH CLI，管理操作不可用。',
      pendingRestart: revision(manifestPath) !== initialRevision || operations.some(job => job.phase === 'interrupted' && job.restartRequired),
      busy: submitting || !!owner, busyReason: owner ? busyReason || '主机任务正在启动；可查看操作记录。' : '',
      profileLock: await profileLock(profile.dir, probe).then(lock => lock && ({ state: lock.state, message: lock.message })),
      recovery: legacyLock ? { id: owner.id, reason: '旧任务锁没有进程信息，需在主机核对后手动解除。' } : null,
      capabilities: { preflight: true, restore: true }, items, runtime, runtimeAvailable, operations }
  }
  function recoverLegacy(body) {
    if (!profile?.cli || submitting) throw fail('当前不能恢复任务', 409)
    const lockPath = join(storage, 'lock.json')
    if (!existsSync(lockPath)) throw fail('任务锁已变化，请刷新', 409)
    const owner = read(lockPath)
    if (!idPattern.test(body.id || '') || body.id !== owner.id || owner.launcherPid || owner.workerPid || owner.cliPid || existsSync(join(storage, 'launch-' + owner.id + '.json'))) throw fail('仅支持人工恢复无进程信息的旧任务锁', 409)
    if (revision(manifestPath) !== body.revision) throw fail('插件列表已变化，请刷新', 409)
    if (body.confirmNoRunningProcess !== true) throw fail('请先在主机确认插件安装进程已退出', 409)
    const jobPath = join(storage, 'job-' + owner.id + '.json')
    if (existsSync(jobPath)) {
      const job = read(jobPath)
      if (['queued', 'running'].includes(job.phase)) {
        job.phase = 'interrupted'; job.endedAt = Date.now(); job.restartRequired = true
        job.message = '用户核对进程后解除了旧任务锁；保留现有文件和备份，未执行自动回滚。'
        atomic(jobPath, job)
      }
    }
    renameSync(lockPath, join(storage, 'recovered-lock-' + owner.id + '.json'))
    return { ok: true }
  }
  async function submit(body) {
    if (!profile?.cli) throw fail('Current DSH profile is read-only', 409)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Invalid operation')
    const { id, action, name, version } = body
    if (!idPattern.test(id || '') || !packagePattern.test(name || '') || !['install', 'update', 'remove', 'enable', 'disable', 'restore'].includes(action)) throw fail('Invalid operation')
    const selfUpdate = name === 'dsh-remote-plugin' && action === 'update'
    if (protectedPackage(name) && !selfUpdate && action !== 'restore') throw fail('核心插件与 Remote 的卸载、启停请通过主机维护流程管理', 409)
    if (selfUpdate && body.confirmSelfUpdate !== true) throw fail('请确认 Remote 本体更新及重启后生效', 409)
    mkdirSync(storage, { recursive: true, mode: 0o700 })
    await recoverDeadLock(storage, probe)
    const jobPath = join(storage, 'job-' + id + '.json')
    if (existsSync(jobPath)) {
      const previous = read(jobPath)
      if (previous.action !== action || previous.name !== name || previous.version !== (version || '') || (previous.restoreFrom || '') !== (body.restoreFrom || '') || (previous.planKey || '') !== (body.preflightKey || '')) throw fail('Operation id already used', 409)
      return publicJob(previous)
    }
    if (submitting) throw fail('另一个插件操作正在准备中', 409)
    submitting = true
    try {
      if (revision(manifestPath) !== body.revision) throw fail('插件列表已变化，请刷新后重试', 409)
      const manifest = read(manifestPath)
      const installed = Object.hasOwn(manifest.dependencies || {}, name)
      if (action !== 'restore' && (action === 'install' && installed || action !== 'install' && !installed)) throw fail('安装状态已变化，请刷新', 409)
      let plan = null, restoreFrom = null
      if (body.preflightKey) {
        if (!/^[a-f0-9]{64}$/.test(body.preflightKey)) throw fail('无效的预检凭据')
        const preflightPath = join(storage, 'preflight-' + body.preflightKey + '.json')
        if (!existsSync(preflightPath)) throw fail('预检凭据已失效，请重新预检', 409)
        plan = read(preflightPath)
        if (plan.action !== action || plan.name !== name || plan.version !== (version || '') || plan.expiresAt < Date.now() || plan.revision !== profileRevision(profile.dir)) throw fail('预检已过期或配置已变化，请重新预检', 409)
        if ((plan.blockers.length || plan.ruleChanges.length) && body.confirmReleasePolicy !== true) throw fail('请明确批准预检中列出的精确版本豁免及重复规则合并', 409)
      }
      if (action === 'restore') {
        if (!idPattern.test(body.restoreFrom || '') || body.confirmRestore !== true) throw fail('请确认恢复失败前的插件和配置', 409)
        const source = read(join(storage, 'job-' + body.restoreFrom + '.json'))
        if (source.name !== name || !['failed', 'interrupted'].includes(source.phase) || !source.recoveryState || source.restoredBy) throw fail('该任务没有可安全恢复的备份', 409)
        if (source.recoveryState.revision !== profileRevision(profile.dir)) throw fail('失败后配置已改变，请在主机核对', 409)
        restoreFrom = body.restoreFrom
      }
      if (['install', 'update'].includes(action)) {
        if (!versionPattern.test(version || '')) throw fail('需要明确的版本号')
        const metadata = await details(name, version)
        if (!metadata.bundle) throw fail('该版本未声明 DSH bundle，不能作为插件安装')
      }
      if (['enable', 'disable'].includes(action)) {
        const pkg = read(join(profile.dir, 'node_modules', ...name.split('/'), 'package.json'))
        if (!pkg.dsh?.bundle?.patch) throw fail('该依赖不是 DSH bundle')
      }
      if (revision(manifestPath) !== body.revision) throw fail('插件配置已变化，请刷新', 409)
      const lock = join(storage, 'lock.json')
      try { writeFileSync(lock, JSON.stringify({ id, launcherPid: process.pid, createdAt: Date.now() }), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if (error.code === 'EEXIST') throw fail('已有插件任务运行中；请查看操作记录', 409); throw error }
      const job = { id, action, name, version: version || '', revision: body.revision, profile: profile.name, phase: 'queued', stage: 'queued', startedAt: Date.now(), updatedAt: Date.now(), log: '', restartRequired: false,
        ...(plan ? { plan, planKey: body.preflightKey } : {}), ...(restoreFrom ? { restoreFrom } : {}) }
      try {
        atomic(jobPath, job)
        const pid = await launch([profile.dir, profile.cli, id, profile.cliMode || 'node'])
        // Separate ledger: the launcher must never overwrite a worker's CLI PID.
        if (Number.isInteger(pid) && pid > 0) atomic(join(storage, 'launch-' + id + '.json'), { pid })
      } catch (error) {
        job.phase = 'failed'; job.message = '无法启动插件任务'; job.endedAt = Date.now()
        atomic(jobPath, job); unlinkSync(lock); throw error
      }
      return publicJob(job)
    } finally { submitting = false }
  }
  async function handle(method, sub, body = {}, query = new URLSearchParams()) {
    if (method === 'GET' && sub === '/state') return inventory()
    if (method === 'GET' && sub === '/details') return { ok: true, item: await details(query.get('name') || '', query.get('version') || 'latest') }
    if (method === 'GET' && sub === '/readme') return readme(query.get('name') || '', query.get('version') || '')
    if (method === 'GET' && sub === '/market/indexes') return market.indexes()
    if (method === 'GET' && sub === '/market') {
      const q = String(query.get('q') || '').trim()
      const sort = query.get('sort') || (q ? 'relevance' : 'index')
      if (!['index', 'relevance', 'published'].includes(sort)) return { ok: false, code: 'invalid-query' }
      return market.search(query.get('index') || '', { text: q, offset: Number(query.get('offset') || 0), limit: 20,
        sort: sort === 'published' ? { kind: sort, direction: 'desc' } : { kind: sort },
        ...(query.get('category') ? { category: query.get('category') } : {}),
        ...(query.has('fetchedAt') ? { fetchedAt: Number(query.get('fetchedAt')) } : {}),
        ...(query.get('refresh') === '1' ? { refresh: true } : {}) })
    }
    if (method === 'POST' && sub === '/operations') {
      if (['install', 'update', 'remove'].includes(body.action) && !body.preflightKey) throw fail('请先预检并确认更新计划；旧版客户端需升级 Remote 页面', 409)
      return { ok: true, operation: await submit(body) }
    }
    if (method === 'POST' && sub === '/preflight') return preflight(body)
    if (method === 'POST' && sub === '/recover') return recoverLegacy(body)
    throw fail('Unknown plugin endpoint', 404)
  }
  return { handle, inventory, submit, preflight }
}

function publicJob(job) {
  const { id, action, name, version, profile, phase, stage, startedAt, endedAt, updatedAt, lastOutputAt, log, message, restartRequired } = job
  return { id, action, name, version, profile, phase, stage, startedAt, endedAt, updatedAt, lastOutputAt, log, message, restartRequired,
    canRestore: !!job.recoveryState && !job.restoredBy && ['failed', 'interrupted'].includes(phase), restoredBy: job.restoredBy || '' }
}

// pnpm refuses packages younger than `minimumReleaseAge` and verifies the whole
// lockfile up front, so one immature entry fails every install — including a
// rollback to an older version. Same-name rules in `minimumReleaseAgeExclude`
// are matched first-match-wins, so the entry pnpm appends on each install can be
// silently dead. Neither fact is visible in the raw pnpm output.
const immaturePublished = /^\s*((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@([^\s@]+)\s+was published at\s/
export function immatureReleaseNotice(log) {
  if (typeof log !== 'string' || !/MINIMUM_RELEASE_AGE_VIOLATION/.test(log)) return null
  const entries = []
  for (const line of log.split('\n')) {
    const match = immaturePublished.exec(line)
    if (match && !entries.some(entry => entry.name === match[1] && entry.version === match[2])) entries.push({ name: match[1], version: match[2] })
  }
  const shown = entries.slice(0, 5).map(entry => entry.name + '@' + entry.version).join('、') + (entries.length > 5 ? ' 等 ' + entries.length + ' 条' : '')
  return (entries.length === 0
    ? 'pnpm 的供应链策略拒绝了当前 pnpm-lock.yaml：其中至少一条记录发布不满 minimumReleaseAge，但日志没有列出具体条目。'
    : 'pnpm 的供应链策略拦住了 ' + shown + '（发布不满 minimumReleaseAge）。')
    + '请在主机核对 profile 的 pnpm-workspace.yaml：同一个包名只会生效第一条 minimumReleaseAgeExclude 规则，第二条起被静默忽略，而 pnpm 每次成功安装都会自动追加一条，所以后追加的豁免可能等于不存在；'
    + '并且校验覆盖整份 lockfile，只要有一条不合格，安装和降级回滚会一起失败。请返回插件详情重新预检，核对后批准列出的精确版本；同名包的精确版本豁免会合并成一条（`- 包名@版本 || 版本`）。'
    + '也可等待日志中被拦包的最小发布年龄窗口结束后再重试。报错包可能不是本次更新目标，失败也不表示已安装目标版本；配置备份保存在当前 profile 的 .remote-plugin-center/backup-任务ID 目录。文件可能已改变，本次未自动回滚。'
}

export async function runWorker(dir, cli, id, execute = runCli, cliMode = 'node', probe = probeProcesses) {
  if (!idPattern.test(id || '')) throw fail('Invalid worker id')
  const storage = join(dir, '.remote-plugin-center')
  const lock = join(storage, 'lock.json')
  const owner = read(lock)
  if (owner.id !== id || owner.workerPid && owner.workerPid !== process.pid) throw fail('Worker does not own lock')
  atomic(lock, { ...owner, workerPid: process.pid })
  const jobPath = join(storage, 'job-' + id + '.json')
  const job = read(jobPath)
  const manifestPath = join(dir, 'package.json')
  const disabledPath = join(storage, 'disabled.json')
  let disabled
  const save = () => { job.updatedAt = Date.now(); atomic(jobPath, job) }
  const progress = (stage, message) => { job.stage = stage; job.message = message; save() }
  const guarded = async task => {
    const file = join(dir, 'package.json.lock'), owner = String(process.pid)
    try { writeFileSync(file, owner, { flag: 'wx', mode: 0o600 }) }
    catch { throw fail('DSH 配置锁已被其他进程取得，已停止操作；请稍后重试', 409) }
    try { return await task() }
    finally { if (ownershipText(file) === owner) unlinkSync(file) }
  }
  let heartbeat
  try {
    job.phase = 'running'; progress('backup', '正在备份配置文件。')
    heartbeat = setInterval(save, 4000); heartbeat.unref()
    if (job.revision !== revision(manifestPath)) throw fail('任务开始前 profile 已变化，请刷新后重试')
    disabled = new Set(existsSync(disabledPath) ? read(disabledPath) : [])
    const backup = join(storage, 'backup-' + id)
    mkdirSync(backup, { mode: 0o700 })
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'cordis.yml', '.npmrc']) {
      if (existsSync(join(dir, name))) copyFileSync(join(dir, name), join(backup, name))
    }
    if (existsSync(disabledPath)) copyFileSync(disabledPath, join(backup, 'disabled.json'))
    if (job.name === 'dsh-remote-plugin' && !job.plan) cpSync(join(dir, 'node_modules', 'dsh-remote-plugin'), join(backup, 'remote-plugin'), { recursive: true, dereference: true })
    progress('profile-lock', '正在检查 DSH 配置锁。')
    const existingLock = await profileLock(dir, probe)
    if (existingLock) {
      if (existingLock.state !== 'dead') throw fail(existingLock.message, 409)
      // No await between final ownership comparison, backup and removal.
      if (!existsSync(existingLock.path) || readFileSync(existingLock.path, 'utf8') !== existingLock.raw) throw fail('DSH 配置锁已变化，请刷新后重试', 409)
      copyFileSync(existingLock.path, join(backup, 'package.json.lock'))
      unlinkSync(existingLock.path)
      job.log += '已备份并回收确认退出的进程遗留的 DSH 配置锁。\n'
    }
    if (job.revision !== revision(manifestPath)) throw fail('检查配置锁期间 profile 已变化，请刷新后重试')
    if (job.restoreFrom) {
      const sourcePath = join(storage, 'job-' + job.restoreFrom + '.json'), source = read(sourcePath)
      progress('restore', '正在核验并恢复更新前的插件文件和配置。')
      await guarded(() => restoreTransaction(dir, join(storage, 'backup-' + job.restoreFrom), source.recoveryState, backup))
      source.restoredBy = job.id; atomic(sourcePath, source)
      job.phase = 'complete'; job.stage = 'complete'; job.restartRequired = true
      job.message = '已恢复更新前的插件文件和配置，校验通过；请重启 DSH。失败现场副本已保留。'
      return
    }
    if (job.plan) {
      if (job.plan.expiresAt < Date.now() || profileRevision(dir) !== job.plan.revision) throw fail('预检已过期或配置改变，未执行安装，请重新预检')
      progress('snapshot', '正在备份全部插件文件和配置，完成前不会安装。')
      await guarded(async () => {
        await backupTransaction(dir, backup)
        if (profileRevision(dir) !== job.plan.revision) throw fail('备份期间配置发生变化，未执行安装')
        job.transactionStarted = true; save()
        writeWorkspace(dir, job.plan.workspace)
      })
    }
    if (['install', 'update', 'remove'].includes(job.action)) {
      progress('cli', '正在运行 DSH 插件命令，等待主机输出。')
      const args = job.action === 'remove' ? ['remove', job.name, '--config.ignore-scripts=true'] : ['add', job.name + '@' + job.version, '--save-exact', '--ignore-scripts', '--registry=' + REGISTRY]
      await execute(cli, ['plugin', '--profile', basename(dir), ...args], dir, chunk => {
        job.lastOutputAt = Date.now()
        job.log = (job.log + chunk.replace(/\x1b\[[0-9;]*m/g, '').replace(/(token|password|authorization)\s*[=:]\s*\S+/gi, '$1=[redacted]')).slice(-12000)
        save()
      }, pid => atomic(lock, { ...read(lock), cliPid: pid }), cliMode)
    }
    const verify = () => {
      progress('verify', '正在保存配置并核验插件状态。')
      if (job.action === 'disable') disabled.add(job.name)
      if (job.action === 'enable' || job.action === 'remove') disabled.delete(job.name)
      const manifest = read(manifestPath)
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => !disabled.has(name))
      if (job.action === 'enable' && !manifest.dsh.profile.bundles.includes(job.name)) manifest.dsh.profile.bundles.push(job.name)
      atomic(manifestPath, manifest)
      atomic(disabledPath, [...disabled])
      const installed = Object.hasOwn(manifest.dependencies || {}, job.name)
      if (job.action === 'remove' ? installed : !installed) throw fail('操作后依赖状态与预期不符')
      if (['install', 'update'].includes(job.action)) {
        const pkg = read(join(dir, 'node_modules', ...job.name.split('/'), 'package.json'))
        if (pkg.version !== job.version || !pkg.dsh?.bundle?.patch) throw fail('安装后的包版本或 bundle 校验失败')
      }
      if (job.plan) {
        // pnpm may append the just-approved version again. Consolidate only rules
        // already present in this transaction, preserving the reviewed policy.
        const workspace = join(dir, 'pnpm-workspace.yaml')
        const normalized = mergeReleaseRules(existsSync(workspace) ? readFileSync(workspace, 'utf8') : null).raw
        if (JSON.stringify(releasePolicy(normalized, {})) !== JSON.stringify(releasePolicy(job.plan.workspace, {}))) throw fail('执行后发布年龄策略超出已确认范围，请检查并恢复备份')
        writeWorkspace(dir, normalized)
        verifyInstalled(dir, job)
      }
    }
    if (job.plan) await guarded(verify)
    else verify()
    job.phase = 'complete'; job.stage = 'complete'; job.restartRequired = true
    job.message = '配置已保存；重启 DSH 后生效。安装脚本未执行。'
  } catch (error) {
    job.phase = 'failed'; job.message = String(error.message || error)
    if(job.name==='dsh-remote-plugin' && /(?:ERR_PNPM_)?(?:EPERM|EBUSY)/.test(job.log) && /rename/i.test(job.log)) {
      job.message = 'Windows 拒绝替换 Remote 插件目录，可能仍有旧网关或 DSH 进程占用。更新未完成，配置和旧包备份已保留；请退出对应 DSH Desktop 及其 Remote 网关后，使用同一 Desktop 安装自带的 CLI 在当前 profile 重装目标版本，再启动 DSH。不要删除插件目录或强行覆盖；不能假定失败后已自动回滚。'
    }
    const policyNotice = job.message === String(error.message || error) ? immatureReleaseNotice(job.log) : null
    if (policyNotice) job.message = policyNotice
    if (job.transactionStarted) {
      try { job.recoveryState = { revision: profileRevision(dir), installed: treeDigest(join(dir, 'node_modules')) }; job.message += ' 可使用“恢复更新前状态”还原插件和配置；恢复前会再次核验文件未被修改。' }
      catch { job.message += ' 无法完整核验失败现场，请在主机退出 DSH 后使用本任务备份恢复。' }
    }
    // A failed package manager may have changed files. Never claim rollback.
    job.restartRequired = true
  } finally {
    clearInterval(heartbeat)
    job.endedAt = Date.now(); save()
    if (existsSync(lock) && read(lock).id === id) unlinkSync(lock)
  }
}

export function cliInvocation(cli, args, dir, cliMode = 'node', runtime = process) {
  if (!['node', 'desktop'].includes(cliMode)) throw fail('Unsupported CLI mode')
  return { command: runtime.execPath, args: [...(cliMode === 'desktop' ? ['--expose-internals'] : []), cli, ...args],
    env: { ...runtime.env, DSH_HOME: dirname(dirname(dir)), npm_config_ignore_scripts: 'true',
      ...(cliMode === 'desktop' ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } }
}

function runCli(cli, args, dir, output, onSpawn, cliMode) {
  return new Promise((resolveRun, reject) => {
    const invocation = cliInvocation(cli, args, dir, cliMode)
    const child = spawn(invocation.command, invocation.args, { cwd: dir, env: invocation.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.once('spawn', () => onSpawn(child.pid))
    child.stdout.on('data', chunk => output(chunk.toString()))
    child.stderr.on('data', chunk => output(chunk.toString()))
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveRun() : reject(fail('DSH 插件命令失败，退出码 ' + code)))
  })
}

if (process.argv[2] === '--worker' && process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(SELF)) {
  await runWorker(process.argv[3], process.argv[4], process.argv[5], undefined, process.argv[6])
}
