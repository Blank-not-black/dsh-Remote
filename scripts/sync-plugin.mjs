/* 同步根 public/ 主控制台文件到 bundle 插件包 (git 源安装只带插件子树) */
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'public')
const dst = join(root, 'packages', 'plugin', 'public')
const files = ['index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'version.json']

await mkdir(dst, { recursive: true })
for (const name of await readdir(dst)) {
  if (!files.includes(name)) await rm(join(dst, name), { recursive: true })
}
for (const name of files) await copyFile(join(src, name), join(dst, name))
console.log(`synced ${files.length} files -> packages/plugin/public`)
