#!/usr/bin/env node
/* 一键发版: bump 版本 → commit → push main → 打 tag → push tag
 * CI (release-build.yml) 会自动完成: 构建 APK/单文件二进制 → GitHub Release → npm → 独立仓库。
 * 用法: npm run release 0.4.9          (发布)
 *       npm run release 0.4.9 -- --dry-run  (只改本地文件, 不提交不推送)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const version = process.argv[2] || ''
const dry = process.argv.includes('--dry-run')
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
writeJson(join(root, 'public', 'update.json'), {
  version,
  apkUrl: 'dsh-remote.apk',
  notes: rootPkg.updateNotes || ''
})
console.log(`版本 ${old} -> ${version}`)
if (dry) {
  console.log('--dry-run: 已写入本地文件, 未提交/未推送')
  process.exit(0)
}

// 2) commit + push + tag
const run = (args) => execFileSync('git', args, { cwd: root, stdio: 'inherit' })
run(['add', 'package.json', 'packages/plugin/package.json', 'package-lock.json', 'public/version.json', 'public/update.json'])
run(['commit', '-m', `release: v${version}`])
run(['push', 'origin', 'main'])
run(['tag', '-f', `v${version}`])
run(['push', 'origin', `v${version}`, '--force'])

console.log(`\n已推送 tag v${version}。CI 将自动完成:`)
console.log('  GitHub Release 资产 (APK + Linux/Win 单文件网关)')
console.log('  npm publish (dsh-remote-plugin)')
console.log('  独立仓库 dsh-remote-plugin 同步')
console.log('本机验证: gh run watch $(gh run list --workflow=release-build.yml --limit 1 --json databaseId --jq .[0].databaseId)')
