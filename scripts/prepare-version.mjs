/* 构建 APK 前把当前 package.json 版本写入 public/version.json + update.json。
 * 之前 build-app 直接 cap sync 打包 public/, 而 publish.js 在 build 之后才更新版本文件,
 * 导致 APK 内 version.json 总是上一个版本, App 装完仍提示可升级。此脚本在 cap sync 前运行。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version || '0.0.0'

writeFileSync(join(root, 'public', 'version.json'), JSON.stringify({ version }, null, 2) + '\n')
writeFileSync(join(root, 'public', 'update.json'), JSON.stringify({
  version,
  apkUrl: 'dsh-remote.apk',
  releasedAt: new Date().toISOString(),
  notes: pkg.updateNotes || ''
}, null, 2) + '\n')

console.log(`prepare-version: public/version.json + update.json -> v${version}`)
