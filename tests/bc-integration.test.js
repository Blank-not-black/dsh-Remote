'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')

const mobile = read('public/app.js')
const desktop = read('public/desktop/desktop.js')
const htmlWithoutBuildIds = file => read(file).replace(/\?dsr-build=[a-f0-9]+/g, '')
const mobileHtml = htmlWithoutBuildIds('public/index.html')
const desktopHtml = htmlWithoutBuildIds('public/desktop/desktop.html')
const packageJson = JSON.parse(read('package.json'))

test('B/C 模块资源在手机端和桌面端都加载，且模块先于入口脚本', () => {
  for (const [html, prefix] of [[mobileHtml, ''], [desktopHtml, '../']]) {
    for (const asset of ['composer-tools.css', 'session-search.css', 'session-management.css', 'plan-review.css', 'turn-diff.css']) {
      assert.match(html, new RegExp(`<link rel="stylesheet" href="${prefix.replace(/\//g, '\\/')}${asset.replace(/\./g, '\\.')}">`), asset)
    }
    const entry = prefix ? 'src="desktop.js"' : 'src="app.js"'
    const entryAt = html.indexOf(entry)
    assert.notEqual(entryAt, -1, entry)
    for (const script of ['composer-tools.js', 'session-search.js', 'session-management.js', 'plan-review.js', 'turn-diff.js']) {
      const scriptTag = `<script src="${prefix}${script}"></script>`
      const at = html.indexOf(scriptTag)
      assert.ok(at >= 0, script)
      assert.ok(at < entryAt, `${script} must load before ${entry}`)
    }
  }
})

test('两个入口都接入输入、搜索、管理与审阅模块并刷新主机状态', () => {
  for (const source of [mobile, desktop]) {
    assert.match(source, /function initBcFeatures\(/)
    assert.match(source, /initComposerToolsUi\(\)/)
    assert.match(source, /initSessionSearchUi\(\)/)
    assert.match(source, /initSessionManagementUi\(\)/)
    assert.match(source, /initReviewFeatures\(\)/)
    assert.match(source, /DshComposerTools\.create\(/)
    assert.match(source, /DshSlashSuggestions\?\.mount\(/)
    assert.match(source, /commands: false/)
    assert.match(source, /'skills\.list'/)
    assert.match(source, /'fileReferences\.list'/)
    assert.match(source, /'sessionReferenceResolver\.candidates'/)
    assert.match(source, /DshSessionSearch\.init\(/)
    assert.match(source, /DshSessionManagement\.init\(/)
    assert.match(source, /DshPlanReview\.create\(/)
    assert.match(source, /DshTurnDiff\.create\(/)
    assert.match(source, /turnDiffHtmlFor\(entry\)/)
    assert.match(source, /planReviewController\?\.handleFrame/)
    assert.match(source, /hostQueue\?\.accept/)
    assert.match(source, /'schedule\/changed'/)
    assert.match(source, /'host\/pinned-sessions-changed'/)
    assert.match(source, /turnDiffController\?\.handleEvent/)
    assert.match(source, /formatQuotes/)
    assert.match(source, /clearQuotes/)
  }
  assert.match(mobile, /state\.wbPinned/)
  assert.match(desktop, /state\.pinnedIds/)
  assert.match(mobile, /data-unarchive-session/)
})

test('计划审阅走主机 question/响应，普通审批不冒充计划审批', () => {
  for (const source of [mobile, desktop]) {
    assert.match(source, /isPlanReviewQuestion/)
    assert.match(source, /planReviewOf\?\.\(question\?\.questions\)/)
    assert.match(source, /respond\(rpcId, value\)/)
    assert.match(source, /runSlashCommand\(line, true\)/)
    assert.match(source, /question\/requested/)
    assert.match(source, /question\/resolved/)
  }
})

test('交付物/Diff 开关默认关闭，关闭时不渲染卡片也不读取 Host Diff', () => {
  for (const source of [mobile, desktop]) {
    assert.match(source, /LS\.get\('turnDiffEnabled', '0'\) === '1'/)
    assert.match(source, /turnDiffController\?\.setEnabled\(checkbox\.checked\)/)
    assert.match(source, /'deliverables\/presented', 'workspace\/changes'/)
  }
  const turnDiff = read('public/turn-diff.js')
  assert.match(turnDiff, /if \(!view \|\| view\.enabled !== true\) return ''/)
  assert.match(turnDiff, /\/api\/changes\.summary/)
  assert.match(turnDiff, /\/api\/changes\.diff/)
})

test('新增模块纳入本地检查，且没有引入运行时依赖', () => {
  for (const file of ['public/composer-tools.js', 'public/session-search.js', 'public/session-management.js', 'public/plan-review.js', 'public/turn-diff.js']) {
    assert.ok(packageJson.scripts.check.includes(`node --check ${file}`), file)
  }
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), [
    '@capacitor/android', '@capacitor/app', '@capacitor/camera', '@capacitor/core', '@capacitor/local-notifications',
  ])
})

test('中英文文案覆盖新增入口，不把模块内部文案冒充主机内容', () => {
  for (const key of ['sessions.search', 'session.unarchive', 'workspace.manage', 'workspace.renamePrompt',
    'composer.quoteSelection', 'settings.turnDiffTitle', 'settings.turnDiffDesc']) {
    assert.ok(mobileHtml.includes(`'${key}':`), key)
  }
  for (const key of ['ds.searchSessions', 'ds.manageWorkspaces', 'ds.workspaceRenamePrompt',
    'ds.quoteSelection', 'ds.turnDiffTitle', 'ds.turnDiffDesc']) {
    assert.ok(desktopHtml.includes(`'${key}':`), key)
  }
})
