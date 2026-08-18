#!/usr/bin/env node
/**
 * 发布脚本: 把刚构建的 APK 放到网关静态目录, 并生成版本/更新描述文件。
 * 用法: npm run build-app && npm run publish
 * 每次发版前改 package.json 的 version 与 updateNotes 字段即可。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const root = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const apkSrc = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
// 不放进 public/: 否则 cap sync 会把 APK 再打回 App assets, 体积递归膨胀
const apkDst = path.join(root, 'apk', 'dsh-remote.apk')

if (!fs.existsSync(apkSrc)) {
  console.error('未找到 APK: ' + apkSrc)
  console.error('请先运行: npm run build-app')
  process.exit(1)
}

fs.mkdirSync(path.dirname(apkDst), { recursive: true })
fs.copyFileSync(apkSrc, apkDst)
const apkSha256 = crypto.createHash('sha256').update(fs.readFileSync(apkDst)).digest('hex')
const updatePath = path.join(root, 'public', 'update.json')
let history = []
if (fs.existsSync(updatePath)) {
  try {
    const old = JSON.parse(fs.readFileSync(updatePath, 'utf8'))
    if (Array.isArray(old.history)) {
      history = old.history.filter(h => h && typeof h.version === 'string' && typeof h.notes === 'string')
    }
  } catch {}
}
if (!String(pkg.version).includes('-rc')) {
  history = history.filter(h => h.version !== pkg.version)
  history.unshift({ version: pkg.version, notes: pkg.updateNotes || '' })
  history = history.filter(h => !String(h.version).includes('-rc')).slice(0, 10)
}
fs.writeFileSync(path.join(root, 'public', 'version.json'),
  JSON.stringify({ version: pkg.version }, null, 2) + '\n')
fs.writeFileSync(updatePath,
  JSON.stringify({
    version: pkg.version,
    apkUrl: 'dsh-remote.apk',
    sha256: apkSha256,
    releasedAt: new Date().toISOString(),
    notes: pkg.updateNotes || '',
    history
  }, null, 2) + '\n')

console.log('已发布 v' + pkg.version)
console.log('  APK:        apk/dsh-remote.apk (' + (fs.statSync(apkDst).size / 1048576).toFixed(1) + ' MB)')
console.log('  SHA-256:    ' + apkSha256)
console.log('  update.json: ' + JSON.stringify({ version: pkg.version, sha256: apkSha256, notes: pkg.updateNotes || '' }))
console.log('App 内「设置 → 检查更新」即可升级。')
