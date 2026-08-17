/* 生成插件专用 root 仓库 (github.com/Blank-not-black/dsh-remote-plugin)
 * 供 Oh-My-DSH 等目录收录: 它们的自动发现规则要求 monorepo workspace 必须已发布 npm,
 * 而 root 包声明 dsh.bundle.patch 即可免 npm 直接收录。
 * 用法: npm run sync-standalone   (默认目标 /tmp/dsh-remote-plugin-standalone)
 *       SYNC_STANDALONE_DIR=/path/to/repo npm run sync-standalone
 * 推送认证:
 *   - 设置 DSH_RELEASE_DEPLOY_KEY(独立仓库 deploy key 的私钥)时走 SSH, 推荐用于 CI
 *   - 未设置时走 https, 依赖本机 gh 凭据助手
 * 注意: 仓库元数据(README/package.json.repository)永远使用无认证的公开 URL。
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'packages', 'plugin')
const dst = process.env.SYNC_STANDALONE_DIR || '/tmp/dsh-remote-plugin-standalone'
const remoteNoAuth = 'https://github.com/Blank-not-black/dsh-remote-plugin.git'

const deployKey = (process.env.DSH_RELEASE_DEPLOY_KEY || '').trim()
const remote = deployKey ? 'git@github.com:Blank-not-black/dsh-remote-plugin.git' : remoteNoAuth
const keyFile = deployKey ? join(tmpdir(), `dsh-standalone-key-${process.pid}`) : null
const gitEnv = { ...process.env }
if (keyFile) {
  writeFileSync(keyFile, deployKey + '\n', { mode: 0o600 })
  chmodSync(keyFile, 0o600)
  gitEnv.GIT_SSH_COMMAND = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`
}
const run = (args) => {
  const r = spawnSync('git', args, { cwd: dst, stdio: 'inherit', env: gitEnv })
  if (r.status !== 0) throw new Error('git ' + args[0] + ' 失败')
}
const cleanup = () => { if (keyFile) { try { rmSync(keyFile, { force: true }) } catch {} } }

try {
  // 每次从远程 main 全量重建工作区, 避免陈旧文件与历史分叉
  rmSync(dst, { recursive: true, force: true })
  mkdirSync(dst, { recursive: true })
  run(['init', '-b', 'main'])
  run(['remote', 'add', 'origin', remote])
  run(['config', 'user.name', 'dsh-remote-release-bot'])
  run(['config', 'user.email', 'dsh-remote-release@users.noreply.github.com'])
  const fetch = spawnSync('git', ['fetch', 'origin', 'main'], { cwd: dst, stdio: 'inherit', env: gitEnv })
  if (fetch.status === 0) {
    run(['checkout', '-B', 'main', 'origin/main'])
  }

  // 1:1 复制的文件(保持产物入库的 git-source 安装形态)
  for (const name of ['index.mjs', 'client.js', 'gateway.cjs', 'gateway-stats.js', 'cordis.patch.yml']) {
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

  // package.json: root 仓库元数据指向独立仓库的公开地址(绝不能带认证信息)
  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'))
  pkg.homepage = 'https://github.com/Blank-not-black/dsh-remote-plugin'
  pkg.repository = { type: 'git', url: 'git+' + remoteNoAuth, directory: undefined }
  if (!pkg.repository.directory) delete pkg.repository.directory
  pkg.description = 'DSH Remote bundle 插件（独立包形态）：DSH 原生侧边栏入口 + 右侧抽屉管理页；内置网关随 DSH 自动启停，直显令牌与设备监控；配套 Android App 远程操控 DSH。源码: ' + pkg.homepage
  writeFileSync(join(dst, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

  run(['add', '-A'])
  run(['commit', '-m', 'chore: sync dsh-remote-plugin v' + pkg.version + ' from monorepo'])
  run(['push', '-u', 'origin', 'main'])
  console.log('standalone repo synced ->', dst)
} finally {
  cleanup()
}
