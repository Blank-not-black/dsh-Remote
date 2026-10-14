/* Profile-scoped plugin management. No shell input, dependencies or client-selected paths. */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, copyFileSync, cpSync, unlinkSync, realpathSync, openSync, closeSync } from 'node:fs'
import { dirname, basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'

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

async function registryJson(path) {
  const response = await fetch(REGISTRY + path, { signal: AbortSignal.timeout(20000), redirect: 'error' })
  if (!response.ok) throw fail('npm registry: HTTP ' + response.status, 502)
  let raw = '', bytes = 0
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > 8 * 1024 * 1024) throw fail('Registry response too large', 502)
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

export function createPluginCenter(ctx, options = {}) {
  const profile = options.profile === undefined ? detectProfile(ctx) : options.profile
  const details = options.details || pluginDetails
  const probe = options.probeProcesses || probeProcesses
  const launch = options.launch || (args => {
    const desktop = profile?.cliMode === 'desktop'
    const errorLog = openSync(join(profile.dir, '.remote-plugin-center', 'worker-' + args[2] + '.log'), 'a', 0o600)
    let child
    try {
      child = spawn(process.execPath, [...(desktop ? ['--expose-internals'] : []), SELF, '--worker', ...args], {
        detached: true, windowsHide: true, stdio: ['ignore', 'ignore', errorLog],
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
    return { ok: true, profile: profile.name, revision: revision(manifestPath), writable: !!profile.cli,
      reason: profile.cli ? '' : profile.name === 'desktop'
        ? '未能验证当前桌面安装的插件管理入口；仅显示状态，请检查 DSH Desktop 版本与安装完整性。'
        : '当前启动方式没有可验证的 DSH CLI，管理操作不可用。',
      pendingRestart: revision(manifestPath) !== initialRevision || operations.some(job => job.phase === 'interrupted' && job.restartRequired),
      busy: submitting || !!owner, busyReason: owner ? busyReason || '主机任务正在启动；可查看操作记录。' : '',
      profileLock: await profileLock(profile.dir, probe).then(lock => lock && ({ state: lock.state, message: lock.message })),
      recovery: legacyLock ? { id: owner.id, reason: '旧任务锁没有进程信息，需在主机核对后手动解除。' } : null,
      items, runtime, runtimeAvailable, operations }
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
    if (!idPattern.test(id || '') || !packagePattern.test(name || '') || !['install', 'update', 'remove', 'enable', 'disable'].includes(action)) throw fail('Invalid operation')
    const selfUpdate = name === 'dsh-remote-plugin' && action === 'update'
    if (protectedPackage(name) && !selfUpdate) throw fail('核心插件与 Remote 的卸载、启停请通过主机维护流程管理', 409)
    if (selfUpdate && body.confirmSelfUpdate !== true) throw fail('请确认 Remote 本体更新及重启后生效', 409)
    mkdirSync(storage, { recursive: true, mode: 0o700 })
    await recoverDeadLock(storage, probe)
    const jobPath = join(storage, 'job-' + id + '.json')
    if (existsSync(jobPath)) {
      const previous = read(jobPath)
      if (previous.action !== action || previous.name !== name || previous.version !== (version || '')) throw fail('Operation id already used', 409)
      return publicJob(previous)
    }
    if (submitting) throw fail('另一个插件操作正在准备中', 409)
    submitting = true
    try {
      if (revision(manifestPath) !== body.revision) throw fail('插件列表已变化，请刷新后重试', 409)
      const manifest = read(manifestPath)
      const installed = Object.hasOwn(manifest.dependencies || {}, name)
      if (action === 'install' && installed || action !== 'install' && !installed) throw fail('安装状态已变化，请刷新', 409)
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
      const job = { id, action, name, version: version || '', revision: body.revision, profile: profile.name, phase: 'queued', stage: 'queued', startedAt: Date.now(), updatedAt: Date.now(), log: '', restartRequired: false }
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
    if (method === 'GET' && sub === '/market') {
      const q = String(query.get('q') || '').trim()
      if (q.length > 80) throw fail('Search too long')
      const offset = Number(query.get('offset') || 0)
      if (!Number.isInteger(offset) || offset < 0 || offset > 1000) throw fail('Invalid offset')
      const data = await registryJson('/-/v1/search?text=' + encodeURIComponent('keywords:dsh-plugin ' + q) + '&size=20&from=' + offset)
      return { ok: true, source: REGISTRY, total: data.total || 0, items: (data.objects || []).map(({ package: p }) => ({ name: p.name, version: p.version, description: p.description || '' })) }
    }
    if (method === 'POST' && sub === '/operations') return { ok: true, operation: await submit(body) }
    if (method === 'POST' && sub === '/recover') return recoverLegacy(body)
    throw fail('Unknown plugin endpoint', 404)
  }
  return { handle, inventory, submit }
}

function publicJob(job) {
  const { id, action, name, version, profile, phase, stage, startedAt, endedAt, updatedAt, lastOutputAt, log, message, restartRequired } = job
  return { id, action, name, version, profile, phase, stage, startedAt, endedAt, updatedAt, lastOutputAt, log, message, restartRequired }
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
  let heartbeat
  try {
    job.phase = 'running'; progress('backup', '正在备份配置文件。')
    heartbeat = setInterval(save, 4000); heartbeat.unref()
    if (job.revision !== revision(manifestPath)) throw fail('任务开始前 profile 已变化，请刷新后重试')
    disabled = new Set(existsSync(disabledPath) ? read(disabledPath) : [])
    const backup = join(storage, 'backup-' + id)
    mkdirSync(backup, { mode: 0o700 })
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'cordis.yml']) {
      if (existsSync(join(dir, name))) copyFileSync(join(dir, name), join(backup, name))
    }
    if (existsSync(disabledPath)) copyFileSync(disabledPath, join(backup, 'disabled.json'))
    if (job.name === 'dsh-remote-plugin') cpSync(join(dir, 'node_modules', 'dsh-remote-plugin'), join(backup, 'remote-plugin'), { recursive: true, dereference: true })
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
    if (['install', 'update', 'remove'].includes(job.action)) {
      progress('cli', '正在运行 DSH 插件命令，等待主机输出。')
      const args = job.action === 'remove' ? ['remove', job.name, '--config.ignore-scripts=true'] : ['add', job.name + '@' + job.version, '--save-exact', '--ignore-scripts', '--registry=' + REGISTRY]
      await execute(cli, ['plugin', '--profile', basename(dir), ...args], dir, chunk => {
        job.lastOutputAt = Date.now()
        job.log = (job.log + chunk.replace(/\x1b\[[0-9;]*m/g, '').replace(/(token|password|authorization)\s*[=:]\s*\S+/gi, '$1=[redacted]')).slice(-12000)
        save()
      }, pid => atomic(lock, { ...read(lock), cliPid: pid }), cliMode)
    }
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
    job.phase = 'complete'; job.stage = 'complete'; job.restartRequired = true
    job.message = '配置已保存；重启 DSH 后生效。安装脚本未执行。'
  } catch (error) {
    job.phase = 'failed'; job.message = String(error.message || error)
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

if (process.argv[1] && resolve(process.argv[1]) === SELF && process.argv[2] === '--worker') {
  await runWorker(process.argv[3], process.argv[4], process.argv[5], undefined, process.argv[6])
}
