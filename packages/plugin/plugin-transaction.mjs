/* Bounded pnpm policy inspection and recoverable profile snapshots. Built-ins only. */
import { readFileSync, existsSync, writeFileSync, renameSync, unlinkSync, readdirSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, dirname } from 'node:path'
import { createHash } from 'node:crypto'
const pkgName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const semver = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/
export const controlFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'cordis.yml', '.npmrc', '.remote-plugin-center/disabled.json']
const error = message => Object.assign(new Error(message), { status: 409 })
const text = file => existsSync(file) ? readFileSync(file, 'utf8') : null
const hash = value => createHash('sha256').update(value).digest('hex')
export function profileRevision(dir) { return hash(JSON.stringify(controlFiles.map(name => [name, text(join(dir, name))]))) }
function scalar(raw) {
  const value = raw.trim()
  if (value.startsWith('"')) { try { return JSON.parse(value) } catch { throw error('无法安全解析配置，请在主机检查 YAML 引号。') } }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw error('无法安全解析 YAML 字符串。')
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (/[\[\]{}&*!>]/.test(value) || /(^|\s)\|(?!\|)/.test(value)) throw error('此配置使用复杂 YAML 语法，请在主机处理后重试。')
  return value.replace(/\s+#.*$/, '').trim()
}
function section(raw, key) {
  const lines = (raw || '').split(/\r?\n/), indexes = []
  if (lines.some(line => line.startsWith("'" + key + "':") || line.startsWith('"' + key + '":') || /^<<:/.test(line))) throw error('暂不支持带引号的策略字段或 YAML 合并键，请在主机统一配置后重试。')
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith(key + ':')) indexes.push(i)
  if (indexes.length > 1) throw error('配置存在重复字段 ' + key + '，请在主机检查。')
  const start = indexes[0] ?? -1
  let end = start + 1
  if (start >= 0) while (end < lines.length && (!lines[end].trim() || /^\s|^#/.test(lines[end]))) end++
  return { lines, start, end, inline: start < 0 ? '' : lines[start].slice(key.length + 1).replace(/\s+#.*$/, '').trim() }
}
export function releasePolicy(raw, env = process.env, npmrc = '') {
  const age = section(raw, 'minimumReleaseAge'), excluded = section(raw, 'minimumReleaseAgeExclude')
  if (/^\s*(?:minimum-release-age|minimumReleaseAge)(?:-exclude|Exclude)?(?:\[\])?\s*=/mi.test(npmrc) || Object.keys(env).some(key => /^npm_config_minimum_release_age/i.test(key))) {
    throw error('发布年龄策略由 .npmrc 或环境变量设置，请在主机统一到当前 profile 的 pnpm-workspace.yaml 后重试。')
  }
  const minutes = age.start < 0 ? 1440 : Number(age.inline)
  if (!Number.isSafeInteger(minutes) || minutes < 0 || age.start >= 0 && !/^\d+$/.test(age.inline)) throw error('minimumReleaseAge 必须为非负整数分钟。')
  let rules = []
  if (excluded.start >= 0) {
    if (excluded.inline) {
      try { rules = JSON.parse(excluded.inline) } catch { throw error('请将 minimumReleaseAgeExclude 改为标准 YAML 列表后重试。') }
      if (!Array.isArray(rules)) throw error('发布年龄豁免必须为列表。')
    } else {
      for (const line of excluded.lines.slice(excluded.start + 1, excluded.end)) {
        if (!line.trim() || /^\s*#/.test(line)) continue
        const match = /^\s+-\s+(.+)$/.exec(line)
        if (!match) throw error('无法安全解析发布年龄豁免列表。')
        rules.push(scalar(match[1]))
      }
    }
  }
  const entries = rules.map(rule => {
    if (typeof rule !== 'string') throw error('发布年龄豁免必须为包名字符串。')
    const at = rule.lastIndexOf('@'), name = at > 0 ? rule.slice(0, at) : rule
    const versions = at > 0 ? rule.slice(at + 1).split(/\s*\|\|\s*/) : []
    if (!pkgName.test(name) || versions.some(version => !semver.test(version))) throw error('存在通配或复杂豁免规则，请先在主机核对；Remote 只合并精确版本。')
    return { name, versions }
  })
  return { minutes, entries }
}
export function mergeReleaseRules(raw, additions = []) {
  const { entries } = releasePolicy(raw, {}, ''), grouped = new Map()
  for (const entry of [...entries, ...additions.map(({ name, version }) => ({ name, versions: [version] }))]) {
    if (!pkgName.test(entry.name) || entry.versions.some(version => !semver.test(version))) throw error('无效的精确版本豁免。')
    const previous = grouped.get(entry.name)
    if (previous && (!previous.length || !entry.versions.length)) {
      if (previous.length !== entry.versions.length) throw error('同名包混用了全版本与精确版本豁免，请在主机核对。')
    } else grouped.set(entry.name, [...new Set([...(previous || []), ...entry.versions])])
  }
  const rules = [...grouped].map(([name, versions]) => name + (versions.length ? '@' + versions.join(' || ') : ''))
  const previous = entries.map(entry => entry.name + (entry.versions.length ? '@' + entry.versions.join(' || ') : ''))
  if (JSON.stringify(rules) === JSON.stringify(previous)) return { raw, changes: [] }
  const block = section(raw, 'minimumReleaseAgeExclude'), newline = raw?.includes('\r\n') ? '\r\n' : '\n'
  const replacement = ['minimumReleaseAgeExclude:', ...rules.map(rule => '  - ' + JSON.stringify(rule))]
  const lines = block.start < 0 ? [...block.lines.filter((line, i) => line || i < block.lines.length - 1), ...replacement] : [...block.lines.slice(0, block.start), ...replacement, ...block.lines.slice(block.end)]
  return { raw: lines.join(newline).replace(/(?:\r?\n)*$/, newline), changes: rules.filter(rule => !previous.includes(rule)) }
}
function lockEntries(raw) {
  if (!raw) return []
  const block = section(raw, 'packages'), result = []
  if (block.inline === '{}') return result
  if (block.start < 0) throw error('锁文件缺少 packages 区段，请先在主机修复锁文件。')
  const lines = block.lines.slice(block.start + 1, block.end)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!/^  \S/.test(line)) continue
    const match = /^  (.+):\s*(?:\{\})?\s*$/.exec(line)
    if (!match) throw error('暂不支持此锁文件格式。')
    const key = scalar(match[1]), identity = /^(\/?(?:@[^/]+\/)?[^/@]+)@([^()]+)(?:\(.*\))?$/.exec(key)
    if (!identity || !pkgName.test(identity[1].replace(/^\//, ''))) throw error('锁文件包含不支持的包标识，请在主机检查：' + key.slice(0, 120))
    const name = identity[1].replace(/^\//, ''), reference = identity[2]
    if (reference.startsWith('file:')) {
      let version = ''
      for (let j = i + 1; j < lines.length && !/^  \S/.test(lines[j]); j++) {
        const found = /^    version:\s*(.+)$/.exec(lines[j]); if (found) version = scalar(found[1])
      }
      if (!semver.test(version)) throw error('本地包的锁文件缺少可核验版本：' + name)
      result.push({ name, version, reference })
    } else {
      if (!semver.test(reference)) throw error('锁文件包含非 registry 或旧格式条目，请在主机检查：' + key.slice(0, 120))
      result.push({ name, version: reference })
    }
  }
  if (result.length > 1200) throw error('锁文件超过自动预检范围，请在主机维护。')
  return result
}
// Local tarballs have no registry release age, but retain their pinned version
// for the manifest/lockfile/installed-package consistency check below.
export function lockPackages(raw) { return lockEntries(raw).filter(row => !row.reference) }
export async function prepareReleasePlan(dir, operation, publishedTimes, env = process.env) {
  const before = profileRevision(dir), workspace = text(join(dir, 'pnpm-workspace.yaml'))
  let baselineWarning = ''
  try { verifyInstalled(dir, operation) } catch (failure) { baselineWarning = failure.message }
  const policy = releasePolicy(workspace, env, text(join(dir, '.npmrc')) || '')
  const packages = lockPackages(text(join(dir, 'pnpm-lock.yaml')))
  if (operation.version) packages.push({ name: operation.name, version: operation.version })
  const pairs = [...new Map(packages.map(row => [row.name + '@' + row.version, row])).values()]
  const blockers = [], now = Date.now(), names = [...new Set(pairs.map(row => row.name))]
  let cursor = 0
  // Give large lockfiles multiple request batches, within the client/proxy budget.
  const budget = Math.min(120000, Math.max(20000, Math.ceil(names.length / 6) * 20000))
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), budget)
  try { if (policy.minutes > 0) await Promise.all(Array.from({ length: Math.min(6, names.length) }, async () => {
    while (cursor < names.length) {
      if (controller.signal.aborted) throw error('发布时间预检超时，请重试；不会执行安装。')
      const name = names[cursor++]
      // Matching is deliberately first-name-wins, like pnpm, including dormant duplicates.
      const first = policy.entries.find(rule => rule.name === name)
      const checked = pairs.filter(row => row.name === name && !(first && (!first.versions.length || first.versions.includes(row.version))))
      if (!checked.length) continue
      const times = await publishedTimes(name, controller.signal)
      for (const row of checked) {
        const at = Date.parse(times[row.version])
        if (!Number.isFinite(at) || at > now + 60000) throw error('无法核实 ' + name + '@' + row.version + ' 的发布时间，未放行；请稍后重试。')
        if (at + policy.minutes * 60000 > now) blockers.push({ ...row, publishedAt: new Date(at).toISOString(), eligibleAt: new Date(at + policy.minutes * 60000).toISOString() })
      }
    }
  })) } catch (failure) {
    const timedOut = controller.signal.aborted
    controller.abort()
    if (timedOut) throw error('发布时间预检超时（' + budget / 1000 + ' 秒，' + names.length + ' 个包），不会执行安装；请重试。')
    throw failure
  } finally { clearTimeout(timeout) }
  blockers.sort((a, b) => (a.name + '@' + a.version).localeCompare(b.name + '@' + b.version))
  const merged = mergeReleaseRules(workspace, blockers)
  if (profileRevision(dir) !== before) throw error('预检期间主机配置已变化，请重新预检。')
  return { revision: before, minutes: policy.minutes, blockers, ruleChanges: merged.changes, workspace: merged.raw, baselineWarning,
    action: operation.action, name: operation.name, version: operation.version || '', expiresAt: Date.now() + 10 * 60000 }
}
export function canonicalPath(value) {
  let current = resolve(value)
  const suffix = []
  while (true) {
    try { return join(realpathSync(current), ...suffix) }
    catch (err) {
      const parent = dirname(current)
      if (!['ENOENT', 'ENOTDIR'].includes(err.code) || parent === current) throw err
      suffix.unshift(current.slice(parent.length).replace(/^[\\/]+/, '')); current = parent
    }
  }
}
function inside(root, path) { const rel = relative(canonicalPath(root), canonicalPath(path)); if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw error('快照路径越界。') }
export function treeDigest(root, { localRoot = join(dirname(root), 'local-plugins'), localSnapshotRoot = localRoot, linkIdentityRoot = root, linkedPaths } = {}) {
  if (!existsSync(root)) return null
  root = canonicalPath(root)
  localRoot = localRoot && canonicalPath(localRoot)
  localSnapshotRoot = localSnapshotRoot && canonicalPath(localSnapshotRoot)
  linkIdentityRoot = canonicalPath(linkIdentityRoot)
  const digest = createHash('sha256')
  function walk(dir) {
    for (const entry of readdirSync(dir).sort()) {
      const file = join(dir, entry), info = lstatSync(file)
      digest.update(relative(root, file).replaceAll('\\', '/') + '\0')
      if (info.isSymbolicLink()) {
        const target = canonicalPath(resolve(dirname(join(linkIdentityRoot, relative(root, file))), readlinkSync(file))), rel = relative(linkIdentityRoot, target)
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) {
          // Desktop's bundled local plugins use junctions outside node_modules.
          // Only the same profile's local-plugins is an allowed second root.
          if (!localRoot || !localSnapshotRoot) throw error('快照路径越界：' + relative(root, file))
          inside(localRoot, target)
          const localPath = relative(resolve(localRoot), target), saved = join(localSnapshotRoot, localPath)
          inside(localSnapshotRoot, realpathSync(saved))
          if (!lstatSync(saved).isDirectory()) throw error('本地插件链接必须指向普通目录。')
          linkedPaths?.add(localPath)
          digest.update('local:' + localPath.replaceAll('\\', '/') + ':' + treeDigest(saved, { localRoot: null }))
        } else inside(root, realpathSync(file))
        digest.update('link:' + readlinkSync(file))
      } else if (info.isDirectory()) { digest.update('dir'); walk(file) }
      else if (info.isFile()) digest.update(readFileSync(file))
      else throw error('插件目录包含不支持的文件类型。')
      digest.update('\0')
    }
  }
  walk(root); return digest.digest('hex')
}
export async function backupTransaction(dir, backup) {
  inside(join(dir, '.remote-plugin-center'), backup)
  const localRoot = join(dir, 'local-plugins'), localSnapshotRoot = join(backup, 'local-plugins'), linkedPaths = new Set()
  const before = profileRevision(dir), modules = join(dir, 'node_modules'), installed = treeDigest(modules, { localRoot, linkedPaths })
  const localInstalled = linkedPaths.size ? treeDigest(localRoot, { localRoot: null }) : null
  if (localInstalled !== null) {
    inside(dir, realpathSync(localRoot))
    await cp(localRoot, localSnapshotRoot, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true })
    if (treeDigest(localSnapshotRoot, { localRoot: null }) !== localInstalled) throw error('本地插件备份校验失败，未执行安装。')
  }
  if (installed !== null) await cp(modules, join(backup, 'node_modules'), { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true })
  if (installed !== null && treeDigest(join(backup, 'node_modules'), { localRoot, localSnapshotRoot, linkIdentityRoot: modules }) !== installed) throw error('备份包含不能独立恢复的链接，未执行安装。')
  // Other control files were already copied by the worker; add absent-file facts.
  const record = { files: Object.fromEntries(controlFiles.map(name => [name, text(join(dir, name))])), revision: before, installed, localInstalled }
  if (profileRevision(dir) !== before || treeDigest(modules) !== installed || localInstalled !== null && treeDigest(localRoot, { localRoot: null }) !== localInstalled) throw error('备份期间插件文件或配置发生变化，尚未执行安装。')
  writeFileSync(join(backup, 'transaction.json'), JSON.stringify(record), { mode: 0o600 })
  return record
}
export function writeWorkspace(dir, raw) {
  if (raw === null) return
  const file = join(dir, 'pnpm-workspace.yaml'), tmp = file + '.remote-' + process.pid
  writeFileSync(tmp, raw, { mode: 0o600 }); renameSync(tmp, file)
}
export function verifyInstalled(dir, job) {
  const manifest = JSON.parse(text(join(dir, 'package.json'))), raw = text(join(dir, 'pnpm-lock.yaml'))
  if (!raw) throw error('安装后未生成锁文件，无法确认安装一致性。')
  const importers = section(raw, 'importers'), root = importers.lines.slice(importers.start + 1, importers.end)
  const refs = new Map(); let group = false, name = '', specifier = '', version = '', inRoot = false
  const flush = () => { if (name) refs.set(name, { specifier, version: version.split('(')[0] }); name = ''; specifier = ''; version = '' }
  for (const line of root) {
    if (/^  \S/.test(line)) { flush(); inRoot = /^  (?:\.|'\.'|"\."):\s*$/.test(line); group = false; continue }
    if (!inRoot) continue
    if (/^    \S/.test(line)) { flush(); group = /^    (?:dependencies|devDependencies|optionalDependencies):\s*$/.test(line); continue }
    if (!group) continue
    const key = /^      (.+):\s*$/.exec(line)
    if (key) { flush(); name = scalar(key[1]); continue }
    const value = /^        (specifier|version):\s*(.+)$/.exec(line)
    if (value?.[1] === 'specifier') specifier = scalar(value[2])
    if (value?.[1] === 'version') version = scalar(value[2])
  }
  flush()
  const all = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }
  const localVersions = new Map(lockEntries(raw).filter(row => row.reference).map(row => [row.name + '@' + row.reference, row.version]))
  for (const [name, requested] of Object.entries(all)) {
    if (!pkgName.test(name)) throw error('配置存在无效的依赖包名。')
    const ref = refs.get(name), file = join(dir, 'node_modules', ...name.split('/'), 'package.json')
    const resolvedVersion = ref && (ref.version.startsWith('file:') ? localVersions.get(name + '@' + ref.version) : ref.version)
    if (!ref || ref.specifier !== requested || !semver.test(resolvedVersion || '') || !existsSync(file) || JSON.parse(text(file)).version !== resolvedVersion) throw error('安装后配置、锁文件与插件文件不一致：' + name)
  }
  if ([...refs.keys()].some(name => !Object.hasOwn(all, name))) throw error('锁文件中仍有已移除的直接依赖。')
}
export async function restoreTransaction(dir, sourceBackup, failed, destination) {
  inside(join(dir, '.remote-plugin-center'), sourceBackup); inside(join(dir, '.remote-plugin-center'), destination)
  const record = JSON.parse(text(join(sourceBackup, 'transaction.json')))
  const localRoot = join(dir, 'local-plugins'), localSnapshotRoot = join(sourceBackup, 'local-plugins')
  const checkLocal = () => {
    // Preserve the user's linked source directories. Never silently overwrite
    // them, even if the package manager changed them during a failed install.
    if (record.localInstalled != null && (treeDigest(localRoot, { localRoot: null }) !== record.localInstalled || treeDigest(localSnapshotRoot, { localRoot: null }) !== record.localInstalled)) throw error('本地插件源码或其备份已变化，不能自动恢复；请在主机核对 local-plugins 备份。')
  }
  checkLocal()
  if (profileRevision(dir) !== failed.revision || treeDigest(join(dir, 'node_modules')) !== failed.installed) throw error('失败后插件文件或配置已有新改动，不能覆盖；请在主机核对备份。')
  const source = join(sourceBackup, 'node_modules'), staged = join(destination, 'staged-node_modules'), current = join(dir, 'node_modules'), displaced = join(destination, 'failed-node_modules')
  if (record.installed !== null) {
    await cp(source, staged, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true })
    // Validate source links relative to source instead of accidentally following a new active tree.
    if (treeDigest(source, { localRoot, localSnapshotRoot, linkIdentityRoot: current }) !== record.installed || treeDigest(staged, { localRoot, linkIdentityRoot: current }) !== record.installed) throw error('恢复备份校验失败，未替换插件。')
  }
  checkLocal()
  if (profileRevision(dir) !== failed.revision || treeDigest(current) !== failed.installed) throw error('准备恢复时主机状态发生变化，已停止。')
  const previousFiles = Object.fromEntries(controlFiles.map(name => [name, text(join(dir, name))]))
  let moved = false, installed = false
  const put = (name, value) => { const file = join(dir, name); if (value === null) { if (existsSync(file)) unlinkSync(file) } else { writeFileSync(file + '.remote-' + process.pid, value, { mode: 0o600 }); renameSync(file + '.remote-' + process.pid, file) } }
  try {
    if (existsSync(current)) { renameSync(current, displaced); moved = true }
    if (record.installed !== null) { renameSync(staged, current); installed = true }
    for (const name of controlFiles) put(name, record.files[name])
    if (profileRevision(dir) !== record.revision || treeDigest(current) !== record.installed) throw error('恢复后的文件校验未通过。')
  } catch (failure) {
    try {
      if (installed) renameSync(current, join(destination, 'restore-attempt'))
      if (moved) renameSync(displaced, current)
      for (const name of controlFiles) put(name, previousFiles[name])
    } catch { throw error('恢复过程中存在文件占用或写入失败，请退出 DSH 后在主机使用备份恢复；所有副本已保留。') }
    throw failure
  }
}
