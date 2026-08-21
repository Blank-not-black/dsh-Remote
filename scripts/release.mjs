#!/usr/bin/env node
/* 一键发版: bump 版本 → 本地构建 APK + 同步插件包 → commit → push main → 打 tag → push tag
 * CI (release-build.yml) 会自动完成: 重新构建发布资产 → GitHub Release → npm → 独立仓库。
 * 本地构建是为了让 git 源安装的插件包(apk + public/version.json)与版本号一致;
 * 用 --no-build 可跳过(CI 产物仍正确, 但 monorepo 内插件产物会滞后一个版本)。
 * 用法: npm run release 0.4.9          (完整发布)
 *       npm run release 0.4.9 -- --no-build  (只 bump+tag, 交给 CI)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const version = process.argv[2] || ''
const dry = process.argv.includes('--dry-run')
const noBuild = process.argv.includes('--no-build')
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法: npm run release <x.y.z> [-- --dry-run]')
  process.exit(1)
}

const writeJson = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

// 1) 版本号
const rootPkg = readJson(join(root, 'package.json'))
const old = rootPkg.version
rootPkg.version = version
writeJson(join(root, 'package.json'), rootPkg)

const pluginPkg = readJson(join(root, 'packages', 'plugin', 'package.json'))
pluginPkg.version = version
writeJson(join(root, 'packages', 'plugin', 'package.json'), pluginPkg)

const lock = readJson(join(root, 'package-lock.json'))
lock.version = version
if (lock.packages?.['']) lock.packages[''].version = version
writeJson(join(root, 'package-lock.json'), lock)

writeJson(join(root, 'public', 'version.json'), { version })
const updatePath = join(root, 'public', 'update.json')
let history = []
if (existsSync(updatePath)) {
  try {
    const old = readJson(updatePath)
    if (Array.isArray(old.history)) {
      history = old.history.filter(h => h && typeof h.version === 'string' && typeof h.notes === 'string')
    }
  } catch {}
}
if (!String(version).includes('-rc')) {
  history = history.filter(h => h.version !== version)
  history.unshift({ version, notes: rootPkg.updateNotes || '' })
  history = history.filter(h => !String(h.version).includes('-rc')).slice(0, 10)
}
writeJson(join(root, 'public', 'update.json'), {
  version,
  apkUrl: 'dsh-remote.apk',
  notes: rootPkg.updateNotes || '',
  history
})
console.log(`版本 ${old} -> ${version}`)
if (dry) {
  console.log('--dry-run: 已写入本地文件, 未提交/未推送')
  process.exit(0)
}

if (!noBuild) {
  console.log('本地构建 APK + 同步插件包(保证 git 源安装产物与版本一致)…')
  execFileSync('npm', ['run', 'build-app'], { cwd: root, stdio: 'inherit' })
  execFileSync('npm', ['run', 'publish'], { cwd: root, stdio: 'inherit' })
} else {
  // 即使跳过构建，也要同步版本/前端/网关文件；否则 release 重试或 CI 前置校验
  // 会看到 public/ 与 packages/plugin/public/ 的 update.json 不一致。
  console.log('跳过构建，仅同步插件包文件…')
  execFileSync('npm', ['run', 'sync-plugin'], { cwd: root, stdio: 'inherit' })
}

// 2) commit + push + tag
const run = (args) => execFileSync('git', args, { cwd: root, stdio: 'inherit' })
// 发布必须提交全部源码改动（gateway.js / public / 测试 / CI / README 等），
// 同时 packages/plugin 全量带上 sync-plugin 同步出的产物（含历史遗留的前端同步文件）。
// .gitignore 已排除本地构建目录（.gradle-home/.npm-cache 等），git add -A 不会误提交。
run(['add', '-A'])
run(['commit', '-m', `release: v${version}`])
run(['push', 'origin', 'main'])
run(['tag', '-f', `v${version}`])
run(['push', 'origin', `v${version}`, '--force'])

console.log(`\n已推送 tag v${version}。CI 将自动完成:`)
console.log('  GitHub Release 资产 (APK + Linux/Win 单文件网关)')
console.log('  npm publish (dsh-remote-plugin)')
console.log('  独立仓库 dsh-remote-plugin 同步')
console.log('本机验证: gh run watch $(gh run list --workflow=release-build.yml --limit 1 --json databaseId --jq .[0].databaseId)')
