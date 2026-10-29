/* 同步根 public/ 主控制台文件到 bundle 插件包 (git 源安装只带插件子树)
 * 另外:
 *  - gateway.js 复制为 gateway.cjs(插件包是 ESM, 网关是 CJS)
 *  - apk/dsh-remote.apk 打进插件包: 插件网关直接以局域网方式给手机 App 提供更新,
 *    update.json 保持相对路径 dsh-remote.apk, 不再绕 GitHub。 */
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import './embed-relay.mjs'
import './embed-announcement-forms.mjs'
import './embed-diagnostics.mjs'
import './embed-lan.mjs'
import './prepare-diagnostics-build.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'public')
const dst = join(root, 'packages', 'plugin', 'public')
const files = ['index.html', 'styles.css', 'theme-vars.css', 'history.js', 'link-check.js', 'app.js', 'i18n.js', 'theme.js', 'sha256.js', 'jsqr.min.js', 'md.js', 'transcribe-core.js', 'morphicons-init.js', 'motion.js', 'admin.html', 'admin.js', 'plugin.html', 'plugin.js', 'qrcode.min.js', 'manifest.webmanifest', 'icon.svg', 'plugin-icon.svg', 'donate.png', 'version.json', 'update.json', 'announcements.json']
files.push('workflow.js', 'workflow.css', 'operations.js', 'network.js', 'genui.js', 'genui.css', 'plugin-center.js', 'plugin-center.css', 'insights.js', 'insights.css', 'skills.js', 'skills.css', 'extensions.js', 'extensions.css', 'chat-files.js')
files.push('relay-settings.js', 'relay-settings.css', 'subagents.js', 'subagents.css')
files.push('activity.js', 'turn-results.js', 'announcement-forms.js', 'teams.js')
files.push('task-board.js')
files.push('image-preview.js', 'image-cache.js')
files.push('diagnostics.js','build.json')
files.push('doctor.js', 'doctor.css')
files.push('setup.js', 'setup.css')
files.push('remote-state.js', 'remote-ui.js', 'remote-ui.css')
files.push('session-presets.js')
files.push('permission-presets.js')
files.push('approval-records.js')
files.push('doctor-entry.js')
files.push('onboarding.js', 'onboarding.css')
files.push('file-inbox.js', 'file-inbox.css')
files.push('session-deck.js', 'session-deck.css')
files.push('lan-discovery.js')
const dirs = ['desktop', 'skins', 'vendor']

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

// docs/wiki is authoritative; this dedicated skill reference subtree is generated.
const wikiSrc = join(root, 'docs', 'wiki')
const wikiDst = join(root, 'packages', 'plugin', 'skills', 'dsh-remote-doctor', 'references', 'wiki')
await mkdir(dirname(wikiDst), { recursive: true })
await rm(wikiDst, { recursive: true, force: true })
await cp(wikiSrc, wikiDst, { recursive: true })

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
