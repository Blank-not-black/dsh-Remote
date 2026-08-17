/* 同步根 public/ 主控制台文件到 bundle 插件包 (git 源安装只带插件子树)
 * 另外:
 *  - gateway.js 复制为 gateway.cjs(插件包是 ESM, 网关是 CJS)
 *  - apk/dsh-remote.apk 打进插件包: 插件网关直接以局域网方式给手机 App 提供更新,
 *    update.json 保持相对路径 dsh-remote.apk, 不再绕 GitHub。 */
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'public')
const dst = join(root, 'packages', 'plugin', 'public')
const files = ['index.html', 'styles.css', 'app.js', 'i18n.js', 'theme.js', 'sha256.js', 'jsqr.min.js', 'admin.html', 'admin.js', 'qrcode.min.js', 'manifest.webmanifest', 'icon.svg', 'version.json', 'update.json']

await mkdir(dst, { recursive: true })
for (const name of await readdir(dst)) {
  if (!files.includes(name)) await rm(join(dst, name), { recursive: true })
}
for (const name of files) await copyFile(join(src, name), join(dst, name))

// 插件内自带网关: gateway.js(CJS) -> packages/plugin/gateway.cjs
await copyFile(join(root, 'gateway.js'), join(root, 'packages', 'plugin', 'gateway.cjs'))
// 网关统计核心: gateway.cjs require('./gateway-stats.js')
await copyFile(join(root, 'gateway-stats.js'), join(root, 'packages', 'plugin', 'gateway-stats.js'))

// APK 随插件分发: 插件网关 /dsh-remote.apk 本地提供手机更新
const apkSrc = join(root, 'apk', 'dsh-remote.apk')
const apkDst = join(root, 'packages', 'plugin', 'apk', 'dsh-remote.apk')
await mkdir(join(root, 'packages', 'plugin', 'apk'), { recursive: true })
await copyFile(apkSrc, apkDst)

console.log(`synced ${files.length} files + gateway.cjs + gateway-stats.js + apk/dsh-remote.apk -> packages/plugin`)
