/* 同步根 public/ 主控制台文件到 bundle 插件包 (git 源安装只带插件子树)
 * 另外把 gateway.js 复制为 gateway.cjs(插件包是 ESM, 网关是 CJS),
 * 并生成插件版 update.json(APK 直链 GitHub, 插件分发的网关不需要本地 apk/ 目录)。 */
import { copyFile, mkdir, readdir, rm, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'public')
const dst = join(root, 'packages', 'plugin', 'public')
const files = ['index.html', 'styles.css', 'app.js', 'admin.html', 'admin.js', 'manifest.webmanifest', 'icon.svg', 'version.json']

await mkdir(dst, { recursive: true })
for (const name of await readdir(dst)) {
  if (!files.includes(name)) await rm(join(dst, name), { recursive: true })
}
for (const name of files) await copyFile(join(src, name), join(dst, name))

// 插件内自带网关: gateway.js(CJS) -> packages/plugin/gateway.cjs
await copyFile(join(root, 'gateway.js'), join(root, 'packages', 'plugin', 'gateway.cjs'))

// 插件版 update.json: 手机 App 从插件网关检查更新时, APK 走 GitHub 直链
const upd = JSON.parse(await readFile(join(src, 'update.json'), 'utf8'))
upd.apkUrl = 'https://github.com/Blank-not-black/dsh-Remote/releases/latest/download/dsh-remote.apk'
await writeFile(join(dst, 'update.json'), JSON.stringify(upd, null, 2) + '\n')

console.log(`synced ${files.length} files + gateway.cjs + update.json -> packages/plugin`)
