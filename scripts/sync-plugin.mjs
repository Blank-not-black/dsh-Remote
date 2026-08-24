/* 同步根 public/ 主控制台文件到 bundle 插件包 (git 源安装只带插件子树)
 * 另外:
 *  - gateway.js 复制为 gateway.cjs(插件包是 ESM, 网关是 CJS)
 *  - apk/dsh-remote.apk 打进插件包: 插件网关直接以局域网方式给手机 App 提供更新,
 *    update.json 保持相对路径 dsh-remote.apk, 不再绕 GitHub。 */
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'public')
const dst = join(root, 'packages', 'plugin', 'public')
const files = ['index.html', 'styles.css', 'theme-vars.css', 'app.js', 'i18n.js', 'theme.js', 'sha256.js', 'jsqr.min.js', 'md.js', 'transcribe-core.js', 'admin.html', 'admin.js', 'plugin.html', 'plugin.js', 'qrcode.min.js', 'manifest.webmanifest', 'icon.svg', 'plugin-icon.svg', 'donate.png', 'version.json', 'update.json', 'announcements.json']
const dirs = ['desktop']

await mkdir(dst, { recursive: true })
for (const name of await readdir(dst)) {
  if (!files.includes(name) && !dirs.includes(name)) await rm(join(dst, name), { recursive: true })
}
for (const name of files) await copyFile(join(src, name), join(dst, name))
for (const name of dirs) await cp(join(src, name), join(dst, name), { recursive: true })

// 插件内自带网关: gateway.js(CJS) -> packages/plugin/gateway.cjs
await copyFile(join(root, 'gateway.js'), join(root, 'packages', 'plugin', 'gateway.cjs'))
// 网关统计核心: gateway.cjs require('./gateway-stats.cjs')
await copyFile(join(root, 'gateway-stats.cjs'), join(root, 'packages', 'plugin', 'gateway-stats.cjs'))

// APK 随插件分发: 插件网关 /dsh-remote.apk 本地提供手机更新。
// CI Verify 阶段在 npm run publish 之前运行，此时根 apk/ 尚未生成，跳过 APK 同步即可；
// 正常 publish 流程 publish.js 会先创建 apk/dsh-remote.apk，这里仍会复制。
const apkSrc = join(root, 'apk', 'dsh-remote.apk')
const apkDst = join(root, 'packages', 'plugin', 'apk', 'dsh-remote.apk')
await mkdir(join(root, 'packages', 'plugin', 'apk'), { recursive: true })
let apkSynced = false
if (existsSync(apkSrc)) {
  await copyFile(apkSrc, apkDst)
  apkSynced = true
} else {
  console.warn('skip apk sync: apk/dsh-remote.apk not found (CI Verify before publish)')
}

console.log(`synced ${files.length} files + ${dirs.length} dirs + gateway.cjs + gateway-stats.cjs${apkSynced ? ' + apk/dsh-remote.apk' : ''} -> packages/plugin`)
