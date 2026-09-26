import { util } from '@kit.ArkTS'
import { AppNav } from '../common/AppNav'
import { AppState } from '../services/AppState'
import { StorageService } from '../services/StorageService'
import { GatewayApi } from '../services/GatewayApi'
import { ServerInfo } from '../models/ServerInfo'
import { I18n } from '../common/I18n'
import { Logger } from '../common/Logger'
import { Theme, Design } from '../models/Theme'

/** Record 字段安全读取：类型不符回落默认值（服务端字段可能缺失） */
function recStr(r: Record<string, Object>, key: string, dft: string): string {
  const v = r[key]
  return typeof v === 'string' ? v : dft
}

function recBool(r: Record<string, Object>, key: string, dft: boolean): boolean {
  const v = r[key]
  return typeof v === 'boolean' ? v : dft
}

function recNum(r: Record<string, Object>, key: string, dft: number): number {
  const v = r[key]
  return typeof v === 'number' ? v : dft
}

/** 已安装插件条目（/state items[]） */
export class PluginItem {
  name: string = ''
  description: string = ''
  version: string = ''
  requested: string = ''
  enabled: boolean = false
  managed: boolean = false
  bundle: boolean = false

  /** 版本展示：version 优先，其次 requested，都没有为「内置」 */
  versionLabel(): string {
    return this.version.length > 0 ? this.version
      : (this.requested.length > 0 ? this.requested : I18n.t('内置', 'built-in'))
  }

  static fromRecord(r: Record<string, Object>): PluginItem {
    const item = new PluginItem()
    item.name = recStr(r, 'name', '')
    item.description = recStr(r, 'description', '')
    item.version = recStr(r, 'version', '')
    item.requested = recStr(r, 'requested', '')
    item.enabled = recBool(r, 'enabled', false)
    item.managed = recBool(r, 'managed', false)
    item.bundle = recBool(r, 'bundle', false)
    return item
  }
}

/** 运行时实际加载状态条目（/state runtime[]） */
export class PluginRuntimeEntry {
  name: string = ''
  phase: string = ''
  enabled: boolean = true

  static fromRecord(r: Record<string, Object>): PluginRuntimeEntry {
    const e = new PluginRuntimeEntry()
    e.name = recStr(r, 'name', '')
    e.phase = recStr(r, 'phase', '')
    e.enabled = recBool(r, 'enabled', true)
    return e
  }
}

/** 操作任务记录（/state operations[]） */
export class PluginJob {
  id: string = ''
  action: string = ''
  name: string = ''
  version: string = ''
  phase: string = ''
  startedAt: number = 0
  message: string = ''
  log: string = ''

  static fromRecord(r: Record<string, Object>): PluginJob {
    const j = new PluginJob()
    j.id = recStr(r, 'id', '')
    j.action = recStr(r, 'action', '')
    j.name = recStr(r, 'name', '')
    j.version = recStr(r, 'version', '')
    j.phase = recStr(r, 'phase', '')
    j.startedAt = recNum(r, 'startedAt', 0)
    j.message = recStr(r, 'message', '')
    j.log = recStr(r, 'log', '')
    return j
  }
}

/** npm 目录条目（/market items[]） */
export class MarketItem {
  name: string = ''
  description: string = ''
  version: string = ''

  static fromRecord(r: Record<string, Object>): MarketItem {
    const m = new MarketItem()
    m.name = recStr(r, 'name', '')
    m.description = recStr(r, 'description', '')
    m.version = recStr(r, 'version', '')
    return m
  }
}

/** 包详情（/details item）；engines/peers 可能是对象或字符串，统一转文本展示 */
export class PluginDetail {
  name: string = ''
  version: string = ''
  description: string = ''
  license: string = ''
  bundle: boolean = false
  protectedPkg: boolean = false
  enginesText: string = ''
  peersText: string = ''
  homepage: string = ''

  static fromRecord(r: Record<string, Object>): PluginDetail {
    const d = new PluginDetail()
    d.name = recStr(r, 'name', '')
    d.version = recStr(r, 'version', '')
    d.description = recStr(r, 'description', '')
    d.license = recStr(r, 'license', '')
    d.bundle = recBool(r, 'bundle', false)
    d.protectedPkg = recBool(r, 'protected', false)
    d.enginesText = PluginDetail.jsonish(r['engines'])
    d.peersText = PluginDetail.jsonish(r['peers'])
    const hp = recStr(r, 'homepage', '')
    d.homepage = hp.startsWith('https://') ? hp : ''
    return d
  }

  private static jsonish(v: Object | undefined): string {
    if (v === undefined || v === null) {
      return '{}'
    }
    if (typeof v === 'string') {
      return v as string
    }
    try {
      return JSON.stringify(v)
    } catch (ignore) {
      return '{}'
    }
  }
}

/** 待确认操作：携带幂等 body（重试复用同一 id）与展示信息 */
class ConfirmInfo {
  action: string = ''
  name: string = ''
  version: string = ''
  body: Record<string, Object> = {}

  actionLabel(): string {
    return confirmActionLabel(this.action)
  }
}

function confirmActionLabel(action: string): string {
  if (action === 'install') {
    return I18n.t('安装', 'Install')
  }
  if (action === 'update') {
    return I18n.t('更新', 'Update')
  }
  if (action === 'remove') {
    return I18n.t('卸载', 'Remove')
  }
  if (action === 'enable') {
    return I18n.t('启用', 'Enable')
  }
  if (action === 'disable') {
    return I18n.t('停用', 'Disable')
  }
  return action
}

function jobPhaseLabel(phase: string): string {
  if (phase === 'queued') {
    return I18n.t('等待执行', 'Queued')
  }
  if (phase === 'running') {
    return I18n.t('执行中', 'Running')
  }
  if (phase === 'complete') {
    return I18n.t('已完成', 'Complete')
  }
  if (phase === 'failed') {
    return I18n.t('失败', 'Failed')
  }
  return phase
}

function jobPhaseColor(phase: string): string {
  if (phase === 'failed') {
    return Design.DANGER
  }
  if (phase === 'complete') {
    return Design.SUCCESS
  }
  if (phase === 'running') {
    return Design.WARNING
  }
  return Design.TEXT_SUB(false)
}

/** 时间戳 → 'MM-DD HH:mm' 本地时间（对齐 AnnouncementsPage 手工格式化惯例） */
function formatTime(ts: number): string {
  if (ts <= 0) {
    return ''
  }
  const d = new Date(ts)
  const pad = (n: number): string => n < 10 ? '0' + n : String(n)
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/**
 * 插件中心（0.7.0 功能面对齐：手机/桌面 WebUI「设置 → 插件中心」的原生移植）。
 *
 * 已安装 / 发现插件 / 操作记录；每 4s 轮询 /state 刷新任务进度。
 * 语义对齐 Web 端 DshPluginCenter（public/plugin-center.js）：
 * - 写操作需二次确认，提交后失败可用同一幂等 id 重试；
 * - 任务在主机端执行，关闭页面不取消；
 * - 旧主机端 Remote 插件无该路由时报「不支持」；
 * - 不允许客户端指定主机路径；市场收录不代表安全或兼容性背书。
 */
@Component
export struct PluginCenterPageView {
  @StorageLink('appState') appState: AppState = AppState.instance
  @StorageLink('uiDark') uiDark: boolean = false
  @StorageLink('uiTheme') uiTheme: string = 'deep-space'

  @State tab: string = 'installed'
  /** 状态/错误提示行（对齐 Web pc-message） */
  @State pcMessage: string = ''
  @State pcMsgError: boolean = false
  @State profileText: string = ''
  @State statusLine: string = ''
  @State items: PluginItem[] = []
  @State runtime: PluginRuntimeEntry[] = []
  @State runtimeAvailable: boolean = true
  @State pendingRestart: boolean = false
  @State busy: boolean = false
  @State writable: boolean = false
  /** 乐观锁 revision：写操作回带，服务端据此拒绝过期快照上的提交 */
  @State revision: string = ''
  @State jobs: PluginJob[] = []
  @State marketItems: MarketItem[] = []
  @State marketTotal: number = 0
  @State marketOffset: number = 0
  @State marketQuery: string = ''
  @State detail: PluginDetail | null = null
  /** 详情内「查看指定版本」输入（默认当前详情版本） */
  @State detailVersion: string = ''
  @State confirmInfo: ConfirmInfo | null = null
  @State pendingMutation: boolean = false
  @State runtimeExpanded: boolean = false
  @State loaded: boolean = false

  private pollTimer: number = -1
  /** 竞态序号：搜索/详情响应只应用最后一次请求（对齐 Web searchSequence/detailSequence） */
  private searchSeq: number = 0
  private detailSeq: number = 0

  private surface(): string {
    return Design.SURFACE(this.uiDark)
  }

  private cardBg(): string {
    return Design.SURFACE(this.uiDark)
  }

  private pageBg(): string {
    return Theme.bgOf(Theme.get(this.uiTheme), this.uiDark)
  }

  private accent(): string {
    return Theme.accentOf(Theme.get(this.uiTheme), this.uiDark)
  }

  aboutToAppear(): void {
    this.pcMessage = I18n.t('正在读取插件状态…', 'Loading plugin state…')
    this.pcMsgError = false
    // 首刷成功后清掉加载提示（对齐 Web open()：message('正在读取…') → refresh → message('')）；
    // 之后轮询只在出错时改写提示，避免把「已受理」等用户提示冲掉
    void this.refreshState().then((): void => {
      if (!this.pcMsgError && this.pcMessage === I18n.t('正在读取插件状态…', 'Loading plugin state…')) {
        this.pcMessage = ''
      }
    })
    // 4s 轮询：任务在主机端执行，进度经 /state operations 回流（对齐 Web poll 间隔）
    this.pollTimer = setInterval((): void => {
      void this.refreshState()
    }, 4000) as number
  }

  aboutToDisappear(): void {
    if (this.pollTimer >= 0) {
      clearInterval(this.pollTimer)
      this.pollTimer = -1
    }
  }

  private currentServer(): ServerInfo | null {
    return this.appState.server
  }

  /** 服务端错误文案转译：AUTH 与旧主机无路由两类需要人话 */
  private translateError(msg: string): string {
    if (msg === 'AUTH') {
      return I18n.t('令牌已失效，请重新配对服务器', 'Token invalid; re-pair the server')
    }
    if (msg === 'PLUGIN_CENTER_UNSUPPORTED') {
      return I18n.t('当前服务器不支持插件中心，请升级主机端 Remote 插件',
        'This server does not support the plugin center. Upgrade the host Remote plugin.')
    }
    return msg
  }

  /** 刷新 /state 快照；响应期间切服务器则丢弃（对齐 Web connection.valid 语义） */
  private async refreshState(): Promise<void> {
    const s = this.currentServer()
    if (s === null || s.token.length === 0) {
      this.pcMessage = I18n.t('未连接服务器', 'Server not connected')
      this.pcMsgError = true
      return
    }
    const ctx = s.id
    try {
      const data = await GatewayApi.pluginsState(s.normalizedUrl(), s.token)
      if (this.currentServer()?.id !== ctx) {
        return
      }
      this.applyState(data)
    } catch (e) {
      if (this.currentServer()?.id !== ctx) {
        return
      }
      const msg = (e as Error).message
      this.pcMessage = this.translateError(msg)
      this.pcMsgError = true
      Logger.warn('plugin center state: ' + msg)
    }
  }

  private applyState(data: Record<string, Object>): void {
    this.profileText = recStr(data, 'profile', '')
    const reason = recStr(data, 'reason', '')
    this.statusLine = reason.length > 0 ? reason
      : (recBool(data, 'pendingRestart', false)
        ? I18n.t('插件配置已变更，重启 DSH 后生效。', 'Plugin config changed; takes effect after DSH restarts.')
        : I18n.t('安装到当前连接的 DSH 主机。', 'Installs into the currently connected DSH host.'))
    this.pendingRestart = recBool(data, 'pendingRestart', false)
    this.busy = recBool(data, 'busy', false)
    this.writable = recBool(data, 'writable', false)
    this.runtimeAvailable = recBool(data, 'runtimeAvailable', true)
    const revRaw = data['revision']
    this.revision = typeof revRaw === 'string' ? revRaw as string
      : (typeof revRaw === 'number' ? (revRaw as number).toString() : '')
    const rawItems = data['items'] as Array<Record<string, Object>> ?? []
    const parsed: PluginItem[] = []
    for (const r of rawItems) {
      parsed.push(PluginItem.fromRecord(r))
    }
    this.items = parsed
    const rawRuntime = data['runtime'] as Array<Record<string, Object>> ?? []
    const runtimeList: PluginRuntimeEntry[] = []
    for (const r of rawRuntime) {
      runtimeList.push(PluginRuntimeEntry.fromRecord(r))
    }
    this.runtime = runtimeList
    const rawJobs = data['operations'] as Array<Record<string, Object>> ?? []
    const jobList: PluginJob[] = []
    for (const r of rawJobs) {
      jobList.push(PluginJob.fromRecord(r))
    }
    this.jobs = jobList
    this.loaded = true
  }

  /** 切换页签：回已安装即刷新状态；去发现插件即清空分页重新搜索 */
  private switchTab(tab: string): void {
    this.tab = tab
    if (tab === 'installed') {
      void this.refreshState()
    } else {
      this.marketOffset = 0
      this.marketItems = []
      this.marketTotal = 0
    }
  }

  /** npm 目录搜索（q 为空 = 全量目录），offset 分页每页 20 */
  private async search(): Promise<void> {
    const s = this.currentServer()
    if (s === null || s.token.length === 0) {
      this.pcMessage = I18n.t('未连接服务器', 'Server not connected')
      this.pcMsgError = true
      return
    }
    const seq = ++this.searchSeq
    const ctx = s.id
    const offset = this.marketOffset
    this.pcMessage = I18n.t('正在查询 npm 插件目录…', 'Searching the npm plugin directory…')
    this.pcMsgError = false
    try {
      const data = await GatewayApi.pluginsMarket(s.normalizedUrl(), s.token, this.marketQuery.trim(), offset)
      if (this.tab !== 'market' || seq !== this.searchSeq || this.currentServer()?.id !== ctx) {
        return
      }
      const raw = data['items'] as Array<Record<string, Object>> ?? []
      const list: MarketItem[] = []
      for (const r of raw) {
        list.push(MarketItem.fromRecord(r))
      }
      this.marketItems = list
      this.marketTotal = recNum(data, 'total', 0)
      this.pcMessage = ''
    } catch (e) {
      if (seq !== this.searchSeq || this.currentServer()?.id !== ctx) {
        return
      }
      const msg = (e as Error).message
      this.pcMessage = this.translateError(msg)
      this.pcMsgError = true
    }
  }

  /** 查看包详情（version 为空查最新） */
  private async showDetails(name: string, version: string): Promise<void> {
    const s = this.currentServer()
    if (s === null || s.token.length === 0) {
      this.pcMessage = I18n.t('未连接服务器', 'Server not connected')
      this.pcMsgError = true
      return
    }
    if (name.trim().length === 0) {
      this.pcMessage = I18n.t('请输入包名', 'Enter a package name')
      this.pcMsgError = true
      return
    }
    const seq = ++this.detailSeq
    const ctx = s.id
    this.pcMsgError = false
    try {
      const data = await GatewayApi.pluginsDetails(s.normalizedUrl(), s.token, name.trim(), version.trim())
      if (seq !== this.detailSeq || this.currentServer()?.id !== ctx) {
        return
      }
      const raw = data['item'] as Record<string, Object> | null
      if (raw === null) {
        throw new Error(I18n.t('未找到该包', 'Package not found'))
      }
      this.detail = PluginDetail.fromRecord(raw)
      this.detailVersion = this.detail.version
      this.confirmInfo = null
    } catch (e) {
      if (seq !== this.detailSeq || this.currentServer()?.id !== ctx) {
        return
      }
      const msg = (e as Error).message
      this.pcMessage = this.translateError(msg)
      this.pcMsgError = true
    }
  }

  /** 武装写操作：生成幂等 id + 携带当前 revision，进入确认卡片（不直接提交） */
  private mutate(action: string, name: string, version: string): void {
    if (this.pendingMutation) {
      return
    }
    const body: Record<string, Object> = {}
    body['id'] = util.generateRandomUUID(true)
    body['action'] = action
    body['name'] = name
    if (version.length > 0) {
      body['version'] = version
    }
    if (this.revision.length > 0) {
      body['revision'] = this.revision
    }
    const info = new ConfirmInfo()
    info.action = action
    info.name = name
    info.version = version
    info.body = body
    this.confirmInfo = info
    this.pcMessage = ''
    this.pcMsgError = false
  }

  /**
   * 提交操作任务。失败保留确认卡片：再点「确认」用同一幂等 id 重试（对齐
   * Web executeMutation 的「重试同一请求」），避免重复提交出新任务。
   */
  private async executeMutation(): Promise<void> {
    const info = this.confirmInfo
    if (info === null || this.pendingMutation) {
      return
    }
    const s = this.currentServer()
    if (s === null || s.token.length === 0) {
      this.pcMessage = I18n.t('未连接服务器', 'Server not connected')
      this.pcMsgError = true
      return
    }
    const ctx = s.id
    this.pendingMutation = true
    this.pcMessage = I18n.t('正在提交…', 'Submitting…')
    this.pcMsgError = false
    try {
      await GatewayApi.pluginsOperations(s.normalizedUrl(), s.token, info.body)
      if (this.currentServer()?.id !== ctx) {
        return
      }
      this.pcMessage = I18n.t('已受理，可在操作记录查看结果。', 'Accepted; check the job log for results.')
      this.pcMsgError = false
      this.confirmInfo = null
      this.detail = null
    } catch (e) {
      if (this.currentServer()?.id !== ctx) {
        return
      }
      const msg = (e as Error).message
      this.pcMessage = this.translateError(msg) + I18n.t('；可点「确认」重试同一请求。', '; tap Confirm to retry the same request.')
      this.pcMsgError = true
    } finally {
      this.pendingMutation = false
      void this.refreshState()
    }
  }

  /** 详情页安装/更新按钮可用性（对齐 Web showDetails 的禁用条件） */
  private installEnabled(): boolean {
    const d = this.detail
    if (d === null) {
      return false
    }
    if (!d.bundle || d.protectedPkg || !this.writable || this.busy || this.pendingMutation) {
      return false
    }
    const installed = this.installedByName(d.name)
    return installed === null || installed.version !== d.version
  }

  private installedByName(name: string): PluginItem | null {
    for (const it of this.items) {
      if (it.name === name) {
        return it
      }
    }
    return null
  }

  private installedActionLabel(): string {
    const d = this.detail
    if (d === null) {
      return ''
    }
    const installed = this.installedByName(d.name) !== null
    return (installed ? confirmActionLabel('update') : confirmActionLabel('install')) + ' ' + d.version
  }

  private setPcMessage(msg: string, isError: boolean): void {
    this.pcMessage = msg
    this.pcMsgError = isError
  }

  /** 小胶囊按钮（列表操作用）；disabled 时置灰且不响应 */
  @Builder
  chipButton(label: string, danger: boolean, enabled: boolean, onTap: () => void) {
    Text(label)
      .fontSize(12)
      .fontColor(enabled ? (danger ? Design.DANGER : this.accent()) : Design.TEXT_HINT(this.uiDark))
      .padding({ left: 10, right: 10, top: 5, bottom: 5 })
      .backgroundColor(Design.FILL_LIGHT(this.uiDark))
      .borderRadius(Design.RADIUS_PILL)
      .opacity(enabled ? 1 : 0.45)
      .onClick(() => {
        if (enabled) {
          onTap()
        }
      })
  }

  /** 顶栏右侧文字按钮 */
  @Builder
  textAction(label: string, onTap: () => void) {
    Text(label)
      .fontSize(13)
      .fontColor(this.accent())
      .padding({ left: 10, right: 10, top: 4, bottom: 4 })
      .backgroundColor(Design.FILL_LIGHT(this.uiDark))
      .borderRadius(Design.RADIUS_PILL)
      .onClick(() => {
        onTap()
      })
  }

  @Builder
  tabChip(label: string, key: string) {
    Text(label)
      .fontSize(13)
      .fontColor(this.tab === key ? Color.White : Design.TEXT_SUB(this.uiDark))
      .padding({ left: 14, right: 14, top: 6, bottom: 6 })
      .backgroundColor(this.tab === key ? this.accent() : Design.FILL_LIGHT(this.uiDark))
      .borderRadius(Design.RADIUS_PILL)
      .onClick(() => {
        if (this.tab !== key) {
          this.switchTab(key)
        }
      })
  }

  @Builder
  pluginCard(name: string, desc: string, meta: string, metaColor: string) {
    Column({ space: 4 }) {
      Text(name)
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(Design.TEXT_MAIN(this.uiDark))
        .width('100%')
      if (desc.length > 0) {
        Text(desc)
          .fontSize(12)
          .fontColor(Design.TEXT_SUB(this.uiDark))
          .width('100%')
      }
      if (meta.length > 0) {
        Text(meta)
          .fontSize(12)
          .fontColor(metaColor)
          .width('100%')
      }
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
  }

  @Builder
  runtimeSection() {
    Column({ space: 6 }) {
      Row({ space: 6 }) {
        Text(I18n.t('当前进程实际加载状态 (', 'Runtime load state (') + this.runtime.length.toString() + ')')
          .fontSize(13)
          .fontColor(Design.TEXT_SUB(this.uiDark))
        Text(this.runtimeExpanded ? '▾' : '▸')
          .fontSize(12)
          .fontColor(Design.TEXT_HINT(this.uiDark))
      }
      .width('100%')
      .padding({ top: 6, bottom: 2 })
      .onClick(() => {
        this.runtimeExpanded = !this.runtimeExpanded
      })

      if (this.runtimeExpanded) {
        if (!this.runtimeAvailable) {
          Text(I18n.t('此 DSH 版本未提供加载状态', 'This DSH version does not expose load state'))
            .fontSize(12)
            .fontColor(Design.TEXT_HINT(this.uiDark))
            .width('100%')
        }
        ForEach(this.runtime, (entry: PluginRuntimeEntry) => {
          Text(entry.name + ' · ' + entry.phase + (entry.enabled ? '' : I18n.t(' · disabled', ' · disabled')))
            .fontSize(12)
            .fontColor(Design.TEXT_SUB(this.uiDark))
            .width('100%')
        }, (entry: PluginRuntimeEntry) => entry.name + entry.phase)
      }
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding({ top: 8, bottom: 4 })
  }

  /** 确认卡片文案 helper（@Builder 体内不能写局部 const，取值收进方法） */
  private confirmLabel(): string {
    const info = this.confirmInfo
    return info !== null ? info.actionLabel() : ''
  }

  private confirmTarget(): string {
    const info = this.confirmInfo
    if (info === null) {
      return ''
    }
    return info.version.length > 0 ? info.name + '@' + info.version : info.name
  }

  private confirmIsRemove(): boolean {
    const info = this.confirmInfo
    return info !== null && info.action === 'remove'
  }

  /** 操作确认卡片（替代详情区显示；失败后同卡片重试） */
  @Builder
  confirmCard() {
    Column({ space: 8 }) {
      Text(I18n.t('确认', 'Confirm ') + this.confirmLabel())
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(Design.TEXT_MAIN(this.uiDark))
      Text(this.confirmTarget())
        .fontSize(13)
        .fontColor(Design.TEXT_SUB(this.uiDark))
      Text(I18n.t('插件代码将在 DSH 主机运行；配置修改后需重启 DSH，不会自动重启。',
        'Plugin code runs on the DSH host; config changes need a DSH restart (not automatic).'))
        .fontSize(12)
        .fontColor(Design.WARNING)
        .width('100%')
      Row({ space: 10 }) {
        Button(this.pendingMutation ? I18n.t('提交中…', 'Submitting…') : this.confirmLabel())
          .height(34)
          .fontSize(14)
          .fontColor(Color.White)
          .backgroundColor(this.confirmIsRemove() ? Design.DANGER : this.accent())
          .enabled(!this.pendingMutation)
          .opacity(this.pendingMutation ? 0.6 : 1)
          .onClick(() => {
            void this.executeMutation()
          })
        Button(I18n.t('取消', 'Cancel'))
          .height(34)
          .fontSize(14)
          .fontColor(Design.TEXT_SUB(this.uiDark))
          .backgroundColor(Design.FILL_LIGHT(this.uiDark))
          .enabled(!this.pendingMutation)
          .onClick(() => {
            this.confirmInfo = null
          })
      }
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding(Design.PAD_CARD)
    .borderRadius(Design.RADIUS_CARD)
    .backgroundColor(this.cardBg())
  }

  /** 详情卡片文案 helper（@Builder 体内不能写局部 const，取值收进方法） */
  private detailTitle(): string {
    const d = this.detail
    return d !== null ? d.name + ' @ ' + d.version : ''
  }

  private detailLicenseLine(): string {
    const d = this.detail
    if (d === null) {
      return ''
    }
    return I18n.t('许可证：', 'License: ') + (d.license.length > 0 ? d.license : I18n.t('未声明', 'unspecified')) +
      ' · ' + (d.bundle ? 'DSH bundle' : I18n.t('未声明 DSH bundle', 'no DSH bundle declared'))
  }

  private detailEnginesLine(): string {
    const d = this.detail
    if (d === null) {
      return ''
    }
    return I18n.t('运行要求：', 'Engines: ') + d.enginesText + I18n.t('；依赖要求：', '; peers: ') + d.peersText
  }

  /** 包详情卡片（Web pc-detail 对应） */
  @Builder
  detailCard() {
    Column({ space: 6 }) {
      Text(this.detailTitle())
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(Design.TEXT_MAIN(this.uiDark))
      if (this.detail !== null && this.detail.description.length > 0) {
        Text(this.detail.description)
          .fontSize(12)
          .fontColor(Design.TEXT_SUB(this.uiDark))
          .width('100%')
      }
      Text(this.detailLicenseLine())
        .fontSize(12)
        .fontColor(Design.TEXT_SUB(this.uiDark))
        .width('100%')
      Text(this.detailEnginesLine())
        .fontSize(12)
        .fontColor(Design.TEXT_SUB(this.uiDark))
        .width('100%')
      Text(I18n.t('插件代码将在 DSH 主机运行。安装脚本默认禁用；需要额外配置的插件须在主机完成配置。',
        'Plugin code runs on the DSH host. Install scripts are disabled by default; extra setup belongs on the host.'))
        .fontSize(12)
        .fontColor(Design.WARNING)
        .width('100%')
      if (this.detail !== null && this.detail.homepage.length > 0) {
        Text(I18n.t('项目主页 ↗', 'Homepage ↗'))
          .fontSize(13)
          .fontColor(this.accent())
          .onClick(() => {
            const hp = this.detail?.homepage ?? ''
            if (hp.length > 0) {
              StorageService.getContext()?.openLink(hp)
            }
          })
      }
      Row({ space: 8 }) {
        TextInput({ text: $$this.detailVersion, placeholder: I18n.t('指定版本，如 1.2.3', 'Pin a version, e.g. 1.2.3') })
          .fontSize(13)
          .height(36)
          .layoutWeight(1)
          .backgroundColor(Design.FILL_LIGHT(this.uiDark))
        this.textAction(I18n.t('查看此版本', 'View version'), () => {
          const cur = this.detail
          if (cur !== null) {
            void this.showDetails(cur.name, this.detailVersion)
          }
        })
      }
      .width('100%')
      Row({ space: 10 }) {
        Button(this.installedActionLabel())
          .height(34)
          .fontSize(14)
          .fontColor(Color.White)
          .backgroundColor(this.accent())
          .enabled(this.installEnabled())
          .opacity(this.installEnabled() ? 1 : 0.45)
          .onClick(() => {
            const cur = this.detail
            if (cur !== null) {
              this.mutate(this.installedByName(cur.name) !== null ? 'update' : 'install', cur.name, cur.version)
            }
          })
        this.textAction(I18n.t('关闭详情', 'Close details'), () => {
          this.detail = null
          this.confirmInfo = null
        })
      }
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding(Design.PAD_CARD)
    .borderRadius(Design.RADIUS_CARD)
    .backgroundColor(this.cardBg())
  }

  /** 已安装列表操作区：查看更新 / 启停 / 卸载（仅 managed 且 writable） */
  @Builder
  installedActions(item: PluginItem) {
    Row({ space: 8 }) {
      this.chipButton(I18n.t('查看更新', 'Check updates'), false, !this.pendingMutation && !this.busy, () => {
        void this.showDetails(item.name, '')
      })
      if (item.bundle) {
        this.chipButton(item.enabled ? I18n.t('停用', 'Disable') : I18n.t('启用', 'Enable'), false,
          !this.pendingMutation && !this.busy, () => {
            this.mutate(item.enabled ? 'disable' : 'enable', item.name, '')
          })
      }
      this.chipButton(I18n.t('卸载', 'Remove'), true, !this.pendingMutation && !this.busy, () => {
        this.mutate('remove', item.name, '')
      })
    }
  }

  @Builder
  installedList() {
    Column({ space: 10 }) {
      if (this.loaded && this.items.length === 0) {
        Text(I18n.t('暂无可管理插件', 'No manageable plugins'))
          .fontSize(13)
          .fontColor(Design.TEXT_HINT(this.uiDark))
          .width('100%')
          .textAlign(TextAlign.Center)
          .padding({ top: 24, bottom: 8 })
      }
      ForEach(this.items, (item: PluginItem) => {
        Column({ space: 6 }) {
          this.pluginCard(item.name, item.description,
            item.versionLabel() + ' · ' + (item.enabled ? I18n.t('配置启用', 'enabled in config')
              : I18n.t('配置停用', 'disabled in config')) +
            (this.pendingRestart ? I18n.t(' · 待重启', ' · restart pending') : ''),
            Design.TEXT_SUB(this.uiDark))
          if (item.managed && this.writable) {
            this.installedActions(item)
          } else {
            Text(I18n.t('内置、核心或只读插件', 'Built-in, core or read-only plugin'))
              .fontSize(11)
              .fontColor(Design.TEXT_HINT(this.uiDark))
              .width('100%')
          }
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')
        .padding(Design.PAD_CARD)
        .borderRadius(Design.RADIUS_CARD)
        .backgroundColor(this.cardBg())
      }, (item: PluginItem) => item.name + item.version)

      // 运行时加载状态：独立卡片始终展示（对齐 Web 列表底部的 details 区块）
      Column() {
        this.runtimeSection()
      }
      .width('100%')
      .padding(Design.PAD_CARD)
      .borderRadius(Design.RADIUS_CARD)
      .backgroundColor(this.cardBg())
    }
    .width('100%')
  }

  @Builder
  marketList() {
    Column({ space: 10 }) {
      Column({ space: 8 }) {
        TextInput({ text: $$this.marketQuery, placeholder: I18n.t('搜索插件或输入完整 npm 包名', 'Search plugins or type a full npm package name') })
          .fontSize(13)
          .height(38)
          .maxLength(80)
          .backgroundColor(Design.FILL_LIGHT(this.uiDark))
        Row({ space: 10 }) {
          this.textAction(I18n.t('搜索', 'Search'), () => {
            this.marketOffset = 0
            void this.search()
          })
          this.textAction(I18n.t('按包名查看', 'Open by name'), () => {
            void this.showDetails(this.marketQuery.trim(), '')
          })
        }
      }
      .width('100%')

      Text(I18n.t('来源：npm · 安装前校验 DSH bundle。目录收录不代表安全或兼容性审核。',
        'Source: npm · DSH bundle is validated before install. Directory listing is not a safety or compatibility review.'))
        .fontSize(11)
        .fontColor(Design.TEXT_HINT(this.uiDark))
        .width('100%')

      ForEach(this.marketItems, (item: MarketItem) => {
        Column({ space: 6 }) {
          this.pluginCard(item.name, item.description, item.version, Design.TEXT_HINT(this.uiDark))
          this.chipButton(I18n.t('查看详情', 'Details'), false, true, () => {
            void this.showDetails(item.name, '')
          })
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')
        .padding(Design.PAD_CARD)
        .borderRadius(Design.RADIUS_CARD)
        .backgroundColor(this.cardBg())
      }, (item: MarketItem) => item.name + item.version)

      if (this.marketItems.length === 0) {
        Text(I18n.t('没有找到插件；也可直接输入完整 npm 包名后查看详情。',
          'No plugins found. You can also type a full npm package name to view details.'))
          .fontSize(12)
          .fontColor(Design.TEXT_HINT(this.uiDark))
          .width('100%')
          .textAlign(TextAlign.Center)
          .padding({ top: 12 })
      }

      if (this.marketOffset > 0 || this.marketOffset + 20 < this.marketTotal) {
        Row({ space: 14 }) {
          if (this.marketOffset > 0) {
            this.textAction(I18n.t('上一页', 'Prev'), () => {
              this.marketOffset -= 20
              void this.search()
            })
          }
          if (this.marketOffset + 20 < this.marketTotal) {
            this.textAction(I18n.t('下一页', 'Next'), () => {
              this.marketOffset += 20
              void this.search()
            })
          }
        }
        .width('100%')
        .justifyContent(FlexAlign.Center)
      }
    }
    .width('100%')
  }

  @Builder
  jobsSection() {
    Column({ space: 10 }) {
      Text(I18n.t('操作记录', 'Job log'))
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor(Design.TEXT_MAIN(this.uiDark))
        .width('100%')
      if (this.jobs.length === 0) {
        Text(I18n.t('暂无任务。任务在主机端执行，可离开本页后回来查看。',
          'No jobs yet. Jobs run on the host and keep running after you leave this page.'))
          .fontSize(12)
          .fontColor(Design.TEXT_HINT(this.uiDark))
          .width('100%')
      }
      ForEach(this.jobs, (job: PluginJob) => {
        Column({ space: 4 }) {
          Text(confirmActionLabel(job.action) + ' ' + job.name +
            (job.version.length > 0 ? '@' + job.version : '') + ' · ' + jobPhaseLabel(job.phase))
            .fontSize(13)
            .fontColor(jobPhaseColor(job.phase))
            .width('100%')
          if (job.startedAt > 0) {
            Text(formatTime(job.startedAt))
              .fontSize(11)
              .fontColor(Design.TEXT_HINT(this.uiDark))
              .width('100%')
          }
          Text(job.message.length > 0 ? job.message
            : I18n.t('任务在主机端执行，可关闭页面后回来查看。', 'Running on the host; you can leave and come back.'))
            .fontSize(12)
            .fontColor(Design.TEXT_SUB(this.uiDark))
            .width('100%')
          if (job.log.length > 0) {
            Text(job.log)
              .fontSize(10)
              .fontFamily('monospace')
              .fontColor(Design.TEXT_HINT(this.uiDark))
              .maxLines(8)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
              .padding(6)
              .backgroundColor(Design.FILL_LIGHT(this.uiDark))
              .borderRadius(Design.RADIUS_SMALL)
          }
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')
        .padding(Design.PAD_CARD)
        .borderRadius(Design.RADIUS_CARD)
        .backgroundColor(this.cardBg())
      }, (job: PluginJob) => job.id + job.phase)
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
  }

  build() {
    Column() {
      Row() {
        Row() {
          Image($r('app.media.ic_back'))
            .width(24)
            .height(24)
            .fillColor(Design.TEXT_MAIN(this.uiDark))
        }
        .width(40)
        .height(40)
        .justifyContent(FlexAlign.Center)
        .margin({ left: -8 })
        .borderRadius(Design.RADIUS_PILL)
        .onClick(() => {
          AppNav.back()
        })
        Text(I18n.t('插件中心', 'Plugin center'))
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .fontColor(Design.TEXT_MAIN(this.uiDark))
          .margin({ left: 4 })
        Blank()
        this.textAction(I18n.t('刷新状态', 'Refresh'), () => {
          void this.refreshState()
        })
      }
      .width('100%')
      .padding({ left: 12, right: 16, top: 10 + Design.safeTop(), bottom: 10 })
      .backgroundColor(this.surface())

      Scroll() {
        Column({ space: 10 }) {
          // 环境与状态（Web pc-profile / pc-status 对应）
          Column({ space: 4 }) {
            Text(this.profileText.length > 0
              ? I18n.t('当前环境：', 'Profile: ') + this.profileText
              : I18n.t('当前环境无法识别', 'Profile unavailable'))
              .fontSize(12)
              .fontColor(Design.TEXT_SUB(this.uiDark))
              .width('100%')
            Text(this.statusLine)
              .fontSize(12)
              .fontColor(Design.TEXT_HINT(this.uiDark))
              .width('100%')
            if (this.pcMessage.length > 0) {
              Text(this.pcMessage)
                .fontSize(12)
                .fontColor(this.pcMsgError ? Design.DANGER : Design.TEXT_SUB(this.uiDark))
                .width('100%')
            }
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')
          .padding(Design.PAD_CARD)
          .borderRadius(Design.RADIUS_CARD)
          .backgroundColor(this.cardBg())

          // 页签
          Row({ space: 10 }) {
            this.tabChip(I18n.t('已安装', 'Installed'), 'installed')
            this.tabChip(I18n.t('发现插件', 'Discover'), 'market')
          }
          .width('100%')

          // 确认卡片优先于详情/列表（Web 将确认放入 detail 区）
          if (this.confirmInfo !== null) {
            this.confirmCard()
          } else if (this.detail !== null) {
            this.detailCard()
          }

          if (this.tab === 'installed') {
            this.installedList()
          } else {
            this.marketList()
          }

          this.jobsSection()
        }
        .width('100%')
        .padding({ left: Design.PAD_PAGE, right: Design.PAD_PAGE, bottom: Design.safeBottom() + 16 })
      }
      .layoutWeight(1)
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.pageBg())
  }
}

/**
 * @Entry 路由页壳（手机端 router 入口）：转发到可内嵌的 PluginCenterPageView。
 * 平板分栏由 TabletIndex 的 navDestination builder 直接挂 PluginCenterPageView。
 */
@Entry
@Component
struct PluginCenterPage {
  build() {
    Column() {
      PluginCenterPageView()
    }
    .width('100%')
    .height('100%')
  }

  /** 抽屉式转场：子页自右滑入、底层左移；返回反向（与公告/反馈等子页一致） */
  pageTransition(): void {
    PageTransitionEnter({ type: RouteType.Push, duration: Design.DRAWER_DURATION, curve: Design.DRAWER_CURVE })
      .slide(SlideEffect.Right)
    PageTransitionExit({ type: RouteType.Push, duration: Design.DRAWER_DURATION, curve: Design.DRAWER_CURVE })
      .slide(SlideEffect.Left)
    PageTransitionEnter({ type: RouteType.Pop, duration: Design.DRAWER_DURATION, curve: Design.DRAWER_CURVE })
      .slide(SlideEffect.Left)
    PageTransitionExit({ type: RouteType.Pop, duration: Design.DRAWER_DURATION, curve: Design.DRAWER_CURVE })
      .slide(SlideEffect.Right)
  }
}
