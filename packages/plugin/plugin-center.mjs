/* Profile-scoped plugin management. No shell input, dependencies or client-selected paths. */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, copyFileSync, unlinkSync, realpathSync } from 'node:fs'
import { dirname, basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

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

export function detectProfile(ctx, cli = process.argv[1]) {
  try {
    const dir = realpathSync(fileURLToPath(ctx.root?.baseUrl || ctx.baseUrl))
    const manifest = read(join(dir, 'package.json'))
    if (basename(dirname(dir)) !== 'profiles' || !Array.isArray(manifest.dsh?.profile?.bundles)) return null
    const name = basename(dir)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*(?![\s\S])/.test(name)) return null
    let root = dirname(realpathSync(cli))
    let found = null
    for (let i = 0; i < 5; i++, root = dirname(root)) {
      try { if (read(join(root, 'package.json')).name === '@deepseek-ai/dsh') { found = join(root, 'lib', 'bin.js'); break } } catch {}
    }
    return { dir, name, home: dirname(dirname(dir)), cli: found && existsSync(found) ? found : null }
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
  const launch = options.launch || (args => {
    const child = spawn(process.execPath, [SELF, '--worker', ...args], { detached: true, windowsHide: true, stdio: 'ignore' })
    return new Promise((resolveLaunch, reject) => {
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); resolveLaunch() })
    })
  })
  const manifestPath = profile && join(profile.dir, 'package.json')
  const initialRevision = profile && revision(manifestPath)
  const storage = profile && join(profile.dir, '.remote-plugin-center')
  let submitting = false
  async function inventory() {
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
      return { name, version: pkg?.version || '', requested: manifest.dependencies?.[name] || '',
        enabled: bundles.includes(name), bundle: !!pkg?.dsh?.bundle?.patch || bundles.includes(name),
        managed: !!manifest.dependencies?.[name] && !protectedPackage(name),
        description: pkg?.description || '' }
    })
    let operations = []
    if (existsSync(storage)) operations = readdirSync(storage).filter(name => /^job-[a-zA-Z0-9-]+\.json$/.test(name)).map(name => {
      try { return read(join(storage, name)) } catch { return null }
    }).filter(Boolean).sort((a, b) => b.startedAt - a.startedAt).slice(0, 20).map(publicJob)
    return { ok: true, profile: profile.name, revision: revision(manifestPath), writable: !!profile.cli,
      reason: profile.cli ? '' : '当前启动方式没有可验证的 DSH CLI，管理操作不可用。',
      pendingRestart: revision(manifestPath) !== initialRevision,
      busy: submitting || existsSync(join(storage, 'lock.json')), items, runtime, runtimeAvailable, operations }
  }
  async function submit(body) {
    if (!profile?.cli) throw fail('Current DSH profile is read-only', 409)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Invalid operation')
    const { id, action, name, version } = body
    if (!idPattern.test(id || '') || !packagePattern.test(name || '') || !['install', 'update', 'remove', 'enable', 'disable'].includes(action)) throw fail('Invalid operation')
    if (protectedPackage(name)) throw fail('核心插件与 Remote 自身请通过主机维护流程管理', 409)
    mkdirSync(storage, { recursive: true, mode: 0o700 })
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
      try { writeFileSync(lock, JSON.stringify({ id }), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if (error.code === 'EEXIST') throw fail('已有插件任务运行中；请查看操作记录', 409); throw error }
      const job = { id, action, name, version: version || '', revision: body.revision, profile: profile.name, phase: 'queued', startedAt: Date.now(), log: '', restartRequired: false }
      try {
        atomic(jobPath, job)
        await launch([profile.dir, profile.cli, id])
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
    throw fail('Unknown plugin endpoint', 404)
  }
  return { handle, inventory, submit }
}

function publicJob(job) {
  const { id, action, name, version, profile, phase, startedAt, endedAt, log, message, restartRequired } = job
  return { id, action, name, version, profile, phase, startedAt, endedAt, log, message, restartRequired }
}

export async function runWorker(dir, cli, id, execute = runCli) {
  if (!idPattern.test(id || '')) throw fail('Invalid worker id')
  const storage = join(dir, '.remote-plugin-center')
  const lock = join(storage, 'lock.json')
  if (read(lock).id !== id) throw fail('Worker does not own lock')
  const jobPath = join(storage, 'job-' + id + '.json')
  const job = read(jobPath)
  const manifestPath = join(dir, 'package.json')
  const disabledPath = join(storage, 'disabled.json')
  let disabled
  const save = () => atomic(jobPath, job)
  try {
    job.phase = 'running'; save()
    if (job.revision !== revision(manifestPath)) throw fail('任务开始前 profile 已变化，请刷新后重试')
    disabled = new Set(existsSync(disabledPath) ? read(disabledPath) : [])
    const backup = join(storage, 'backup-' + id)
    mkdirSync(backup, { mode: 0o700 })
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']) {
      if (existsSync(join(dir, name))) copyFileSync(join(dir, name), join(backup, name))
    }
    if (existsSync(disabledPath)) copyFileSync(disabledPath, join(backup, 'disabled.json'))
    if (['install', 'update', 'remove'].includes(job.action)) {
      const args = job.action === 'remove' ? ['remove', job.name, '--ignore-scripts'] : ['add', job.name + '@' + job.version, '--save-exact', '--ignore-scripts', '--registry=' + REGISTRY]
      await execute(cli, ['plugin', '--profile', basename(dir), ...args], dir, chunk => {
        job.log = (job.log + chunk.replace(/\x1b\[[0-9;]*m/g, '').replace(/(token|password|authorization)\s*[=:]\s*\S+/gi, '$1=[redacted]')).slice(-12000)
        save()
      })
    }
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
    job.phase = 'complete'; job.restartRequired = true
    job.message = '配置已保存；重启 DSH 后生效。安装脚本未执行。'
  } catch (error) {
    job.phase = 'failed'; job.message = String(error.message || error)
    // A failed package manager may have changed files. Never claim rollback.
    job.restartRequired = true
  } finally {
    job.endedAt = Date.now(); save()
    if (read(lock).id === id) unlinkSync(lock)
  }
}

function runCli(cli, args, dir, output) {
  return new Promise((resolveRun, reject) => {
    const env = { ...process.env, DSH_HOME: dirname(dirname(dir)), npm_config_ignore_scripts: 'true' }
    const child = spawn(process.execPath, [cli, ...args], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => output(chunk.toString()))
    child.stderr.on('data', chunk => output(chunk.toString()))
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveRun() : reject(fail('DSH 插件命令失败，退出码 ' + code)))
  })
}

if (process.argv[1] && resolve(process.argv[1]) === SELF && process.argv[2] === '--worker') {
  await runWorker(process.argv[3], process.argv[4], process.argv[5])
}
