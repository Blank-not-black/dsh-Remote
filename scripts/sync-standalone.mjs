/* 生成插件专用 root 仓库 (github.com/Blank-not-black/dsh-remote-plugin)
 * 供 Oh-My-DSH 等目录收录: 它们的自动发现规则要求 monorepo workspace 必须已发布 npm,
 * 而 root 包声明 dsh.bundle.patch 即可免 npm 直接收录。
 * 用法: npm run sync-standalone   (默认目标 /tmp/dsh-remote-plugin-standalone)
 *       SYNC_STANDALONE_DIR=/path/to/repo npm run sync-standalone
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'packages', 'plugin')
const dst = process.env.SYNC_STANDALONE_DIR || '/tmp/dsh-remote-plugin-standalone'
const remote = 'https://github.com/Blank-not-black/dsh-remote-plugin.git'

if (!existsSync(dst)) {
  mkdirSync(dst, { recursive: true })
  const init = spawnSync('git', ['init', '-b', 'main'], { cwd: dst, stdio: 'inherit' })
  if (init.status !== 0) throw new Error('git init 失败')
  const addRemote = spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: dst, stdio: 'inherit' })
  if (addRemote.status !== 0) throw new Error('git remote add 失败')
}

// 1:1 复制的文件(保持产物入库的 git-source 安装形态)
for (const name of ['index.mjs', 'client.js', 'gateway.cjs', 'cordis.patch.yml']) {
  cpSync(join(src, name), join(dst, name))
}
// 复制 public/apk 与插件 README/LICENSE; README 里的 git 源安装改指独立仓库
rmSync(join(dst, 'public'), { recursive: true, force: true })
cpSync(join(src, 'public'), join(dst, 'public'), { recursive: true })
rmSync(join(dst, 'apk'), { recursive: true, force: true })
if (existsSync(join(src, 'apk'))) cpSync(join(src, 'apk'), join(dst, 'apk'), { recursive: true })
let readme = readFileSync(join(src, 'README.md'), 'utf8')
readme = readme.replaceAll('github:Blank-not-black/dsh-Remote#main&path:/packages/plugin', 'github:Blank-not-black/dsh-remote-plugin#main')
writeFileSync(join(dst, 'README.md'), readme)
cpSync(join(root, 'LICENSE'), join(dst, 'LICENSE'))

// package.json: root 仓库元数据要指向独立仓库本身(不能保留 monorepo 的 directory)
const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'))
pkg.homepage = 'https://github.com/Blank-not-black/dsh-remote-plugin'
pkg.repository = { type: 'git', url: 'git+' + remote, directory: undefined }
if (!pkg.repository.directory) delete pkg.repository.directory
pkg.description = 'DSH Remote bundle 插件（独立包形态）：DSH 原生侧边栏入口 + 右侧抽屉管理页；内置网关随 DSH 自动启停，直显令牌与设备监控；配套 Android App 远程操控 DSH。源码: ' + pkg.homepage
writeFileSync(join(dst, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

const run = (args) => {
  const r = spawnSync('git', args, { cwd: dst, stdio: 'inherit' })
  if (r.status !== 0) throw new Error('git ' + args[0] + ' 失败')
}
run(['add', '-A'])
run(['commit', '-m', 'chore: sync dsh-remote-plugin v' + pkg.version + ' from monorepo'])
run(['push', '-u', 'origin', 'main'])
console.log('standalone repo synced ->', dst)
