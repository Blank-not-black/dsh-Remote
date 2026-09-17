import { common } from '@kit.AbilityKit'
import { ServerInfo } from '../models/ServerInfo'
import { HealthInfo } from '../models/HealthInfo'
import { SessionView } from '../models/SessionView'
import { StatsDay } from '../models/StatsDay'
import { PendingApproval, PendingQuestion } from '../models/PendingItem'
import { ApproveValue, AnswerItem, AnswerBody, AnswerValue } from '../models/RpcPayloads'
import { SessionCreatePayload, SessionRenamePayload } from '../models/RpcPayloads'
import { Announcement } from '../models/Announcement'
import { UpdateInfo } from '../models/UpdateInfo'
import { WorkspaceInfo } from '../models/WorkspaceInfo'
import { Theme } from '../models/Theme'
import { Constants } from '../common/Constants'
import { Logger } from '../common/Logger'
import { I18n } from '../common/I18n'
import { StorageService } from './StorageService'
import { GatewayApi } from './GatewayApi'
import { RealtimeService } from './RealtimeService'
import { NotificationService } from './NotificationService'
import { PeakReminderService } from './PeakReminderService'
import { PairParser } from './PairParser'

/**
 * 会话事件回调（ChatPage 注册；payload 中的 event 对象）。
 */
export type ChatEventSink = (ev: Record<string, Object>) => void

/** 会话投影回调（ChatPage 注册；该会话 projection 合并后的 values 快照） */
export type ProjectionSink = (values: Record<string, Object>) => void

/** 公告投票记录 */
export class VoteEntry {
  key: string
  optionId: string

  constructor(key: string, optionId: string) {
    this.key = key
    this.optionId = optionId
  }
}

/**
 * 全局可观察状态：当前服务器、健康、会话、连接模式。
 * 组件通过 @StorageLink('appState') 绑定（EntryAbility 中已 setOrCreate）。
 */
@Observed
export class AppState {
  static readonly instance: AppState = new AppState()

  server: ServerInfo | null = null
  servers: ServerInfo[] = []
  health: HealthInfo | null = null
  /** idle | connecting | ws | poll | error */
  mode: string = 'idle'
  statusText: string = I18n.t('未连接', 'Not connected')
  /** 顶层会话（按 updatedAt 倒序） */
  sessions: SessionView[] = []
  /** 网关返回的会话总数（含子代理），用于诊断展示 */
  totalSessionCount: number = 0
  totalTokens7d: number = 0
  statsText: string = ''
  statsDays: StatsDay[] = []
  lastError: string = ''
  initialized: boolean = false
  /** 当前打开的会话 id（ChatPage 设置） */
  activeSessionId: string = ''
  /** ChatPage 注册的会话事件回调 */
  chatSink: ChatEventSink | null = null
  /** ChatPage 注册的会话投影回调（goal/todo/统计卡片） */
  projectionSink: ProjectionSink | null = null
  /** 每会话 projection 序号（去旧保新，对齐 Web 端 asOfSeq 语义） */
  private projectionSeq: Map<string, number> = new Map()
  /** 每会话 projection 合并值（sessionId → values；goal/todos/sessionStats/...） */
  private projectionValues: Map<string, Record<string, Object>> = new Map()
  /** 待处理的工具审批 */
  pendingApprovals: PendingApproval[] = []
  /** 待处理的用户提问 */
  pendingQuestions: PendingQuestion[] = []
  /** 本地通知开关 */
  notifyEnabled: boolean = false
  /** 当前主题 id */
  themeId: string = Constants.DEFAULT_THEME
  /** 深色模式：system 跟随系统 / light 常浅 / dark 常深 */
  darkMode: string = Constants.DARK_SYSTEM
  /** 后台轮询开关 */
  backgroundPoll: boolean = false
  /** 峰谷提醒开关 */
  peakRemind: boolean = false
  /** 公告列表 */
  announcements: Announcement[] = []
  /** 最新更新信息（检查后） */
  updateInfo: UpdateInfo | null = null
  /** 公告已读 id */
  seenIds: string[] = []
  /** 已投票记录（key: announcementId:pollId） */
  votes: VoteEntry[] = []
  /** 工作区列表（workspace.list，建会话时选择用） */
  workspaces: WorkspaceInfo[] = []
  /** 已归档会话 id（workspace.list.archivedSessionIds，与 Web 端 wbArchived 一致） */
  archivedSessionIds: string[] = []
  /** 已收公告的本地历史（合并去重，按发布时间倒序，最多 50 条） */
  announcementHistory: Announcement[] = []
  private announcementTimer: number = -1

  private refreshTimer: number = -1
  private lastHealthAt: number = 0

  init(context: common.UIAbilityContext): void {
    if (this.initialized) {
      return
    }
    StorageService.init(context)
    // 系统语言判定（无应用内切换，跟随系统；变更下次启动生效）
    I18n.init()
    this.servers = StorageService.getServers()
    this.notifyEnabled = StorageService.getString(Constants.KEY_NOTIFY, '') === '1'
    this.themeId = StorageService.getString(Constants.KEY_THEME, Constants.DEFAULT_THEME)
    this.darkMode = StorageService.getString(Constants.KEY_DARK_MODE, Constants.DARK_SYSTEM)
    this.backgroundPoll = StorageService.getString(Constants.KEY_BG_POLL, '') === '1'
    this.peakRemind = StorageService.getString(Constants.KEY_PEAK_REMIND, '') === '1'
    // 峰谷开关状态落 AppStorage 原语：设置页副标题依赖它刷新
    //（@StorageLink('appState') 观察不到实例属性变更）
    AppStorage.setOrCreate('peakRemind', this.peakRemind)
    // 峰谷提醒恢复：系统代理提醒常驻（优先），缺失时补发或降级进程内定时器
    PeakReminderService.restore(this.peakRemind)
    // 公告本地历史装载 + 30s 轮询（与 Web 端 announcementPollTimer 对齐）
    this.announcementHistory = Announcement.fromJsonArray(
      StorageService.getString(Constants.KEY_ANN_HISTORY, ''))
    this.startAnnouncementPolling()
    const seenJson = StorageService.getString(Constants.KEY_ANN_SEEN, '')
    this.seenIds = this.parseStringArray(seenJson)
    const votesJson = StorageService.getString(Constants.KEY_ANN_VOTES, '')
    this.votes = this.parseVotes(votesJson)
    const activeId = StorageService.getActiveServerId()
    this.applyActiveServer(activeId, true)
    // 深浅判定落 AppStorage：必须在首帧前完成，否则 Design.isDark() 读不到值
    AppStorage.setOrCreate('systemDark', false)
    this.syncThemeStorage()
    this.initialized = true
  }

  /** 手动切换当前服务器并持久化 */
  setCurrentServer(id: string): boolean {
    for (const s of this.servers) {
      if (s.id === id) {
        StorageService.setActiveServerId(id)
        this.applyActiveServer(id, true)
        return true
      }
    }
    return false
  }

  private applyActiveServer(id: string, startRealtime: boolean): void {
    let found: ServerInfo | null = null
    for (const s of this.servers) {
      if (s.id === id) {
        found = s
        break
      }
    }
    this.server = found
    if (!found) {
      this.mode = 'idle'
      this.statusText = I18n.t('未连接', 'Not connected')
      this.health = null
      this.sessions = []
      return
    }
    this.mode = 'connecting'
    this.statusText = I18n.t('连接 ', 'Connecting ') + found.normalizedUrl()
    this.lastError = ''
    this.refreshHealth()
    this.refreshSessions()
    if (startRealtime) {
      this.startRealtime()
    }
  }

  private startRealtime(): void {
    const s = this.server
    if (!s) {
      return
    }
    const clientId = StorageService.getOrCreateClientId()
    RealtimeService.getInstance().start(s.normalizedUrl(), s.token, clientId,
      (kind: string, frame: string) => {
        AppState.instance.handleFrame(kind, frame)
      },
      (m: string) => {
        AppState.instance.onModeChanged(m)
      })
  }

  private onModeChanged(m: string): void {
    this.mode = m
    if (m === 'ws') {
      this.statusText = I18n.t('实时已连接', 'Realtime connected')
    } else if (m === 'poll') {
      this.statusText = I18n.t('轮询模式', 'Polling mode')
    } else if (m === 'connecting') {
      this.statusText = this.server ? I18n.t('连接 ', 'Connecting ') + this.server.normalizedUrl() : I18n.t('连接中', 'Connecting')
    } else if (m === 'error') {
      this.statusText = I18n.t('连接失败', 'Connection failed')
    } else {
      this.statusText = I18n.t('未连接', 'Not connected')
    }
    this.refreshHealth()
  }

  stopRealtime(): void {
    RealtimeService.getInstance().stop()
    this.mode = 'idle'
    this.statusText = I18n.t('未连接', 'Not connected')
  }

  /** 实时帧入口：会话事件转发给 ChatPage，审批/提问进入待处理列表 */
  handleFrame(kind: string, frame: string): void {
    if (frame.length === 0) {
      return
    }
    let full: Record<string, Object> | null = null
    try {
      full = JSON.parse(frame) as Record<string, Object>
    } catch (e) {
      return
    }
    const payload = full['payload'] as Record<string, Object>
    if (!payload) {
      return
    }
    const type = String(payload['type'] ?? '')

    if (kind === 'mux' && type === 'session/event') {
      const sid = String(payload['sessionId'] ?? '')
      const ev = payload['event'] as Record<string, Object>
      if (sid.length > 0 && sid === this.activeSessionId && ev && this.chatSink) {
        this.chatSink(ev)
      }
      return
    }
    if (kind === 'mux' && type === 'approval/requested') {
      const rpcId = String(full['rpcId'] ?? '')
      const approvalId = String(payload['approvalId'] ?? '')
      const sessionId = String(payload['sessionId'] ?? '')
      const toolName = String(payload['toolName'] ?? '工具')
      const summary = String(payload['summary'] ?? '')
      let exists = false
      for (const a of this.pendingApprovals) {
        if (a.approvalId === approvalId && a.rpcId === rpcId) {
          exists = true
          break
        }
      }
      if (!exists) {
        this.pendingApprovals = [...this.pendingApprovals,
          new PendingApproval(rpcId, sessionId, approvalId, toolName, summary)]
        if (this.notifyEnabled) {
          NotificationService.notifyApproval(toolName)
        }
      }
      return
    }
    if (kind === 'mux' && type === 'approval/resolved') {
      const approvalId = String(payload['approvalId'] ?? '')
      this.pendingApprovals = this.pendingApprovals.filter((a) => a.approvalId !== approvalId)
      return
    }
    if (kind === 'mux' && type === 'question/requested') {
      const rpcId = String(full['rpcId'] ?? '')
      const sessionId = String(payload['sessionId'] ?? '')
      const questions = payload['questions'] as Array<Record<string, Object>> ?? []
      const title = questions.length > 0 ?
        String(questions[0]['question'] ?? '') : I18n.t('待回答', 'Pending answer')
      let exists = false
      for (const q of this.pendingQuestions) {
        if (q.rpcId === rpcId) {
          exists = true
          break
        }
      }
      if (!exists) {
        this.pendingQuestions = [...this.pendingQuestions,
          new PendingQuestion(rpcId, sessionId, questions, title)]
        if (this.notifyEnabled) {
          NotificationService.notifyQuestion(title)
        }
      }
      return
    }
    if (kind === 'mux' && type === 'question/resolved') {
      const rpcId = String(payload['questionRpcId'] ?? '')
      this.pendingQuestions = this.pendingQuestions.filter((q) => q.rpcId !== rpcId)
      return
    }
    if (kind === 'mux' && type === 'session/projection') {
      // 投影增量（goal/todos/sessionStats/...）：合并进快照并通知当前会话页
      this.applyProjection(
        String(payload['sessionId'] ?? ''),
        String(payload['key'] ?? ''),
        payload['value'] as Object,
        Number(payload['seq'] ?? 0))
      return
    }
    // host 通道会话状态变化 → 刷新列表
    this.scheduleRefresh()
  }

  /** 投影合并：seq 回退丢弃；当前会话变化时通知 ChatPage 重渲染卡片 */
  private applyProjection(sessionId: string, key: string, value: Object, seq: number): void {
    if (sessionId.length === 0 || key.length === 0) {
      return
    }
    const current = this.projectionSeq.get(sessionId) ?? 0
    if (seq > 0 && seq < current) {
      return
    }
    this.projectionSeq.set(sessionId, Math.max(seq, current))
    let values = this.projectionValues.get(sessionId)
    if (!values) {
      values = {}
    }
    const next: Record<string, Object> = {}
    for (const k of Object.keys(values)) {
      next[k] = values[k]
    }
    next[key] = value
    this.projectionValues.set(sessionId, next)
    if (sessionId === this.activeSessionId && this.projectionSink) {
      this.projectionSink(next)
    }
  }

  /** 会话 projection 合并快照（无数据返回空对象，不共享内部引用） */
  projectionOf(sessionId: string): Record<string, Object> {
    const values = this.projectionValues.get(sessionId)
    if (!values) {
      return {}
    }
    const out: Record<string, Object> = {}
    for (const k of Object.keys(values)) {
      out[k] = values[k]
    }
    return out
  }

  /** 会话 projection 序列号比较（ChatPage 合并 session.list 初值用） */
  projectionSeqOf(sessionId: string): number {
    return this.projectionSeq.get(sessionId) ?? 0
  }

  /** 会话离开时清掉内存快照（历史数据以服务器为准） */
  clearProjection(sessionId: string): void {
    this.projectionSeq.delete(sessionId)
    this.projectionValues.delete(sessionId)
  }

  /** 归档会话（workspace.archiveSession，与 Web 端 sc-archive-btn 一致） */
  async archiveSession(sessionId: string): Promise<boolean> {
    const s = this.server
    if (!s) {
      return false
    }
    try {
      const payload: Record<string, Object> = { 'sessionId': sessionId }
      await GatewayApi.rpc(s.normalizedUrl(), s.token, 'workspace.archiveSession', payload)
      if (this.archivedSessionIds.indexOf(sessionId) < 0) {
        this.archivedSessionIds = [...this.archivedSessionIds, sessionId]
      }
      await this.refreshSessions()
      await this.refreshWorkspaces()
      return true
    } catch (e) {
      this.lastError = I18n.t('归档失败：', 'Archive failed: ') + (e as Error).message
      return false
    }
  }

  /** 公告定时轮询：30s 一次，应用启动即开（fetchAnnouncements 失败静默） */
  private startAnnouncementPolling(): void {
    if (this.announcementTimer >= 0) {
      return
    }
    this.announcementTimer = setInterval(() => {
      this.fetchAnnouncements()
    }, Constants.ANN_POLL_MS)
  }

  /**
   * 设置本地通知开关并持久化。
   * 乐观更新：调用方先翻开关；开启时若通知权限申请失败则回退并返回 false。
   */
  async setNotifyEnabled(enabled: boolean): Promise<boolean> {
    this.notifyEnabled = enabled
    if (enabled) {
      const granted = await NotificationService.requestPermission()
      if (!granted) {
        this.notifyEnabled = false
        StorageService.putString(Constants.KEY_NOTIFY, '0')
        return false
      }
    }
    StorageService.putString(Constants.KEY_NOTIFY, enabled ? '1' : '0')
    return true
  }

  /** 设置通知开关（不回退版本，权限申请失败时保持开启但通知不可用） */
  async setNotifyEnabledUnchecked(enabled: boolean): Promise<void> {
    this.notifyEnabled = enabled
    StorageService.putString(Constants.KEY_NOTIFY, enabled ? '1' : '0')
    if (enabled) {
      await NotificationService.requestPermission()
    }
  }

  /** 切换主题并持久化 */
  setTheme(id: string): void {
    this.themeId = id
    StorageService.putString(Constants.KEY_THEME, id)
    this.syncThemeStorage()
  }

  /**
   * 切换深色模式并持久化（system / light / dark）。
   * 实际生效的深浅写入 AppStorage('uiDark')；window 层（状态栏内容色、
   * 窗口底色）由 Index / EntryAbility 通过 uiDarkMode 原语响应。
   */
  setDarkMode(mode: string): void {
    this.darkMode = mode
    StorageService.putString(Constants.KEY_DARK_MODE, mode)
    this.syncThemeStorage()
  }

  /** 系统色模式变化时回调（EntryAbility.onConfigurationUpdate） */
  onSystemDarkChange(systemDark: boolean): void {
    if (this.darkMode === Constants.DARK_SYSTEM) {
      this.syncThemeStorage()
    }
  }

  /** 当前主题下应使用的深浅判定，写入 AppStorage 供 Design 与页面读取 */
  private syncThemeStorage(): void {
    const dark = this.darkMode === Constants.DARK_DARK ||
      (this.darkMode === Constants.DARK_SYSTEM && AppStorage.get<boolean>('systemDark') === true)
    AppStorage.setOrCreate('uiDark', dark)
    AppStorage.setOrCreate('uiDarkMode', this.darkMode)
    AppStorage.setOrCreate('uiTheme', this.themeId)
  }

  /**
   * 设置后台轮询开关并持久化。
   * 轮询本身是本地定时器必然可用，但审批/提问提醒依赖通知权限——
   * 开启时若通知未授权则回退开关并返回 false，由调用方提示。
   */
  async setBackgroundPoll(enabled: boolean): Promise<boolean> {
    if (enabled) {
      const granted = await NotificationService.requestPermission()
      if (!granted) {
        return false
      }
    }
    this.backgroundPoll = enabled
    StorageService.putString(Constants.KEY_BG_POLL, enabled ? '1' : '0')
    return true
  }

  /**
   * 设置峰谷提醒开关并持久化（对齐 Android 端 opt-peak-remind 行为）。
   * 依赖通知权限——开启时未授权则回退开关返回 false；
   * 系统代理提醒受管控时 PeakReminderService 内部自动降级进程内定时器。
   */
  async setPeakRemind(enabled: boolean): Promise<boolean> {
    if (enabled) {
      const granted = await NotificationService.requestPermission()
      if (!granted) {
        return false
      }
    }
    this.peakRemind = enabled
    // 原语同步写：关→开、开→关都要触发设置页副标题重渲染
    AppStorage.setOrCreate('peakRemind', enabled)
    StorageService.putString(Constants.KEY_PEAK_REMIND, enabled ? '1' : '0')
    if (enabled) {
      await PeakReminderService.start()
    } else {
      await PeakReminderService.stop()
    }
    return true
  }

  /** 工具审批：允许 / 拒绝 */
  async approveApproval(approvalId: string, allow: boolean): Promise<boolean> {
    const s = this.server
    if (!s) {
      return false
    }
    let target: PendingApproval | null = null
    for (const a of this.pendingApprovals) {
      if (a.approvalId === approvalId) {
        target = a
        break
      }
    }
    if (!target) {
      return false
    }
    try {
      const value: ApproveValue = {
        sessionId: target.sessionId,
        approvalId: target.approvalId,
        outcome: allow ? 'allowed-once' : 'rejected'
      }
      const ok = await GatewayApi.respond(s.normalizedUrl(), s.token, target.rpcId, value)
      this.pendingApprovals = this.pendingApprovals.filter((a) => a.approvalId !== approvalId)
      return ok
    } catch (e) {
      Logger.warn('approve failed: ' + (e as Error).message)
      return false
    }
  }

  /** 用户提问：提交回答（answers: [{id, selected[], custom?}]） */
  async answerQuestion(rpcId: string, answers: Array<AnswerItem>): Promise<boolean> {
    const s = this.server
    if (!s) {
      return false
    }
    let target: PendingQuestion | null = null
    for (const q of this.pendingQuestions) {
      if (q.rpcId === rpcId) {
        target = q
        break
      }
    }
    if (!target) {
      return false
    }
    try {
      const body: AnswerBody = { answers: answers }
      const value: AnswerValue = { sessionId: target.sessionId, answer: body }
      const ok = await GatewayApi.respond(s.normalizedUrl(), s.token, target.rpcId, value)
      this.pendingQuestions = this.pendingQuestions.filter((q) => q.rpcId !== rpcId)
      return ok
    } catch (e) {
      Logger.warn('answer failed: ' + (e as Error).message)
      return false
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer >= 0) {
      clearTimeout(this.refreshTimer)
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = -1
      this.refreshSessions()
    }, 600)
  }

  async refreshHealth(): Promise<void> {
    const s = this.server
    if (!s) {
      return
    }
    const now = Date.now()
    if (now - this.lastHealthAt < 3000) {
      return
    }
    this.lastHealthAt = now
    try {
      const h = await GatewayApi.getHealth(s.normalizedUrl())
      this.health = h
      if (this.mode === 'connecting' || this.mode === 'idle') {
        this.mode = 'connecting'
      }
    } catch (e) {
      this.health = null
      this.lastError = I18n.t('网关不可达：', 'Gateway unreachable: ') + s.normalizedUrl()
      Logger.warn(this.lastError)
    }
  }

  async refreshSessions(): Promise<void> {
    const s = this.server
    if (!s || s.token.length === 0) {
      return
    }
    try {
      const empty: Record<string, Object> = {}
      const value = await GatewayApi.rpc(s.normalizedUrl(), s.token, 'session.list', empty)
      // session.list 项内的 projections 是初始快照（对齐 Web 端 hydrateSessionProjections）
      SessionView.hydrateProjections(value,
        (sessionId: string, seq: number, values: Record<string, Object>) => {
          const current = this.projectionSeq.get(sessionId) ?? 0
          if (seq >= current) {
            this.projectionSeq.set(sessionId, seq)
            this.projectionValues.set(sessionId, values)
            if (sessionId === this.activeSessionId && this.projectionSink) {
              this.projectionSink(this.projectionOf(sessionId))
            }
          }
        })
      // 只展示顶层会话（过滤子代理），按最近活动倒序
      const all = SessionView.fromRpcValue(value)
      const top: SessionView[] = []
      for (const item of all) {
        if (item.isTopLevel() && item.sessionId.length > 0) {
          top.push(item)
        }
      }
      top.sort((a: SessionView, b: SessionView) => b.updatedAt - a.updatedAt)
      this.sessions = top
      this.totalSessionCount = all.length
      this.lastError = ''
    } catch (e) {
      const msg = (e as Error).message
      if (msg === 'AUTH') {
        this.lastError = I18n.t('令牌无效，请在设置中重新配置', 'Token invalid; re-pair in Settings')
      } else {
        this.lastError = I18n.t('会话加载失败：', 'Session load failed: ') + msg
      }
      Logger.warn(this.lastError + ' ' + msg)
    }
  }

  async refreshStats(): Promise<void> {
    const s = this.server
    if (!s || s.token.length === 0) {
      return
    }
    try {
      const data = await GatewayApi.statsSummary(s.normalizedUrl(), s.token, Constants.STATS_DAYS)
      const rawDays = data['days'] as Array<Record<string, Object>> ?? []
      this.statsDays = StatsDay.fromArray(rawDays)
      let total: number = 0
      for (const d of this.statsDays) {
        total += d.tokens()
      }
      this.totalTokens7d = total
      this.statsText = I18n.t('近 ' + Constants.STATS_DAYS.toString() + ' 日 Token 总量', 'Token total, last ' + Constants.STATS_DAYS.toString() + ' days')
    } catch (e) {
      this.totalTokens7d = 0
      this.statsDays = []
      this.statsText = I18n.t('统计暂不可用', 'Stats unavailable')
    }
  }

  /**
   * 处理 dshremote://pair?token=..&server=.. 深链（扫码之外的配对入口）。
   * 返回是否成功导入。供 EntryAbility 的 onCreate/onNewWant 调用。
   */
  applyPairUri(uri: string): boolean {
    if (uri.length === 0) {
      return false
    }
    const payload = PairParser.parsePairUrl(uri)
    if (!payload) {
      return false
    }
    const ok = this.addServersFromPair(payload.token, payload.servers)
    Logger.info('pair deep link imported=' + (ok ? '1' : '0'))
    return ok
  }

  /** 新建会话（可指定工作区）；成功返回新 sessionId */
  async createSession(workspaceId: string): Promise<string> {
    const s = this.server
    if (!s || s.token.length === 0) {
      this.lastError = I18n.t('未连接服务器', 'Server not connected')
      return ''
    }
    try {
      const payload: SessionCreatePayload = workspaceId.length > 0 ? { workspaceId: workspaceId } : {}
      const v = await GatewayApi.rpc(s.normalizedUrl(), s.token, 'session.create', payload)
      await this.refreshSessions()
      const rec = v as Record<string, Object>
      return String(rec?.['sessionId'] ?? '')
    } catch (e) {
      this.lastError = I18n.t('创建会话失败：', 'Create session failed: ') + (e as Error).message
      Logger.warn(this.lastError)
      return ''
    }
  }

  /** 重命名会话（session.rename）；成功后刷新列表 */
  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const s = this.server
    if (!s || s.token.length === 0 || sessionId.length === 0) {
      return false
    }
    const trimmed = title.trim()
    if (trimmed.length === 0) {
      return false
    }
    try {
      const payload: SessionRenamePayload = { sessionId: sessionId, title: trimmed }
      await GatewayApi.rpc(s.normalizedUrl(), s.token, 'session.rename', payload)
      await this.refreshSessions()
      return true
    } catch (e) {
      Logger.warn('rename failed: ' + (e as Error).message)
      return false
    }
  }

  /** 拉取工作区列表（workspace.list），供新建会话选择 */
  async refreshWorkspaces(): Promise<void> {
    const s = this.server
    if (!s || s.token.length === 0) {
      this.workspaces = []
      return
    }
    try {
      const empty: Record<string, Object> = {}
      const v = await GatewayApi.rpc(s.normalizedUrl(), s.token, 'workspace.list', empty)
      this.workspaces = WorkspaceInfo.fromRpcValue(v)
      // archivedSessionIds 与 Web 端 wbArchived 同源：workspace.list 顶层字段
      this.archivedSessionIds = []
      const rawArchived = (v as Record<string, Object>)['archivedSessionIds'] as Array<Object> ?? []
      for (const a of rawArchived) {
        const id = String(a ?? '')
        if (id.length > 0) {
          this.archivedSessionIds.push(id)
        }
      }
    } catch (e) {
      // 旧版网关/DSH 无该 RPC 时静默降级为不选工作区
      this.workspaces = []
      Logger.warn('workspace.list failed: ' + (e as Error).message)
    }
  }

  /**
   * 空会话本地清理（离开会话页时调用，与 WebUI shouldDiscardEmptySession 对齐）：
   * 无任何消息且无待处理事项时，从本地列表移除该会话。
   * DSH 侧不删数据，刷新后仍会出现，但该会话已被 DSH 标记为 blank，显示为「新会话」。
   */
  discardEmptySession(sessionId: string): void {
    if (sessionId.length === 0) {
      return
    }
    for (const p of this.pendingApprovals) {
      if (p.sessionId === sessionId) {
        return
      }
    }
    for (const q of this.pendingQuestions) {
      if (q.sessionId === sessionId) {
        return
      }
    }
    let target: SessionView | null = null
    for (const s of this.sessions) {
      if (s.sessionId === sessionId) {
        target = s
        break
      }
    }
    if (!target) {
      return
    }
    // 有消息（非 blank）的会话不清理；running 状态的会话不清理
    if (target.running || !target.blank) {
      return
    }
    this.sessions = this.sessions.filter((s: SessionView) => s.sessionId !== sessionId)
  }

  /** 保存服务器列表（设置页调用）并刷新当前连接 */
  saveServers(list: ServerInfo[], activeId: string): void {
    this.servers = list
    StorageService.saveServers(list)
    StorageService.setActiveServerId(activeId)
    // 重新配置服务器（含扫码/深链配对）即视为重新登录，清掉后台轮询的令牌失效标记
    StorageService.putString(Constants.KEY_LOGIN_EXPIRED, '0')
    this.applyActiveServer(activeId, true)
  }

  /** 拉取公告（公开接口，失败静默） */
  async fetchAnnouncements(): Promise<void> {
    const s = this.server
    if (!s) {
      return
    }
    try {
      const raw = await GatewayApi.fetchAnnouncementsRaw(s.normalizedUrl())
      let list: Array<Record<string, Object>> = []
      if (Array.isArray(raw)) {
        list = raw as Array<Record<string, Object>>
      } else {
        const rec = raw as Record<string, Object>
        const items = rec['items'] as Array<Record<string, Object>>
        if (items) {
          list = items
        }
      }
      const now = Date.now()
      const out: Announcement[] = []
      for (const r of list) {
        const a = Announcement.fromRecord(r)
        if (!a) {
          continue
        }
        if (a.expiresAt > 0 && a.expiresAt < now) {
          continue
        }
        out.push(a)
      }
      out.sort((x: Announcement, y: Announcement) => y.publishedAt - x.publishedAt)
      this.announcements = out
      // 收过的公告进本地历史（合并去重、倒序、上限 50 条，对齐 Web 端 storeAnnouncementHistory）
      this.storeAnnouncementHistory(out)
    } catch (e) {
      // 公告拉取失败不打扰主流程
    }
  }

  /** 公告历史合并落盘（对齐 Web 端 storeAnnouncementHistory：去重、倒序、50 条） */
  private storeAnnouncementHistory(items: Announcement[]): void {
    const merged: Map<string, Announcement> = new Map()
    for (const a of this.announcementHistory) {
      merged.set(a.id, a)
    }
    for (const a of items) {
      merged.set(a.id, a)
    }
    const list: Announcement[] = []
    for (const key of Array.from(merged.keys())) {
      const a = merged.get(key)
      if (a) {
        list.push(a)
      }
    }
    list.sort((x: Announcement, y: Announcement) => y.publishedAt - x.publishedAt)
    this.announcementHistory = list.slice(0, 50)
    StorageService.putString(Constants.KEY_ANN_HISTORY, Announcement.toJsonArray(this.announcementHistory))
  }

  isSeen(id: string): boolean {
    return this.seenIds.indexOf(id) >= 0
  }

  unseenCount(): number {
    let n: number = 0
    for (const a of this.announcements) {
      if (!this.isSeen(a.id)) {
        n++
      }
    }
    return n
  }

  markSeen(id: string): void {
    if (this.isSeen(id)) {
      return
    }
    this.seenIds = [...this.seenIds, id]
    StorageService.putString(Constants.KEY_ANN_SEEN, JSON.stringify(this.seenIds))
  }

  voteFor(announcementId: string, pollId: string): string {
    const key = announcementId + ':' + pollId
    for (const v of this.votes) {
      if (v.key === key) {
        return v.optionId
      }
    }
    return ''
  }

  /** 提交公告投票（POST /feedback），成功记录本地 */
  async submitVote(announcementId: string, pollId: string, optionId: string): Promise<boolean> {
    const s = this.server
    if (!s) {
      return false
    }
    const payload: Record<string, Object> = {
      'type': 'poll',
      'message': 'Poll ' + pollId + ': ' + optionId,
      'announcementId': announcementId,
      'pollId': pollId,
      'optionId': optionId,
      'appVersion': Constants.APP_VERSION
    }
    try {
      const ok = await GatewayApi.postFeedback(s.normalizedUrl(), s.token, payload)
      if (!ok) {
        return false
      }
      const key = announcementId + ':' + pollId
      const next: VoteEntry[] = []
      let found: boolean = false
      for (const v of this.votes) {
        if (v.key === key) {
          next.push(new VoteEntry(key, optionId))
          found = true
        } else {
          next.push(v)
        }
      }
      if (!found) {
        next.push(new VoteEntry(key, optionId))
      }
      this.votes = next
      const recs: Array<Record<string, Object>> = []
      for (const v of next) {
        const r: Record<string, Object> = { 'k': v.key, 'o': v.optionId }
        recs.push(r)
      }
      StorageService.putString(Constants.KEY_ANN_VOTES, JSON.stringify(recs))
      return true
    } catch (e) {
      return false
    }
  }

  /** 提交用户反馈（POST /feedback） */
  async submitFeedback(type: string, message: string, contact: string,
    includeDiagnostics: boolean): Promise<boolean> {
    const s = this.server
    if (!s) {
      return false
    }
    const payload: Record<string, Object> = {
      'type': type,
      'message': message,
      'contact': contact,
      'appVersion': Constants.APP_VERSION,
      'includeDiagnostics': includeDiagnostics
    }
    try {
      return await GatewayApi.postFeedback(s.normalizedUrl(), s.token, payload)
    } catch (e) {
      return false
    }
  }

  /** 检查更新：比较 update.json 版本，有新版时填充 updateInfo */
  async checkUpdate(): Promise<void> {
    const s = this.server
    if (!s) {
      return
    }
    try {
      const raw = await GatewayApi.fetchUpdateInfo(s.normalizedUrl())
      const info = UpdateInfo.fromRecord(raw)
      if (info.version.length === 0) {
        return
      }
      this.updateInfo = info
    } catch (e) {
      // 检查失败静默
    }
  }

  /** 语义化版本比较：a > b 返回 true */
  isNewerThan(a: string, b: string): boolean {
    const pa = a.split('.')
    const pb = b.split('.')
    const len = Math.max(pa.length, pb.length)
    for (let i = 0; i < len; i++) {
      const na = i < pa.length ? Number(pa[i]) : 0
      const nb = i < pb.length ? Number(pb[i]) : 0
      if (na > nb) {
        return true
      }
      if (na < nb) {
        return false
      }
    }
    return false
  }

  private parseStringArray(json: string): string[] {
    try {
      return JSON.parse(json) as Array<string>
    } catch (e) {
      return []
    }
  }

  private parseVotes(json: string): VoteEntry[] {
    try {
      const arr = JSON.parse(json) as Array<Record<string, Object>>
      const out: VoteEntry[] = []
      for (const r of arr) {
        out.push(new VoteEntry(String(r['k'] ?? ''), String(r['o'] ?? '')))
      }
      return out
    } catch (e) {
      return []
    }
  }

  /** 扫码配对导入：token 绑定全部地址（同 url+token 去重），第一个地址设为当前 */
  addServersFromPair(token: string, servers: string[]): boolean {
    if (token.length === 0 || servers.length === 0) {
      return false
    }
    const list: ServerInfo[] = []
    for (const s of this.servers) {
      list.push(new ServerInfo(s.id, s.url, s.note, s.group, s.token))
    }
    let firstId: string = ''
    for (const addr of servers) {
      const url = addr.replace(/\/+$/, '')
      let exists = false
      for (const s of list) {
        if (s.normalizedUrl() === url && s.token === token) {
          exists = true
          if (firstId.length === 0) {
            firstId = s.id
          }
          break
        }
      }
      if (!exists) {
        const id = 's-' + Date.now().toString(36) + '-' + list.length.toString()
        list.push(new ServerInfo(id, url, '', Constants.DEFAULT_GROUP, token))
        if (firstId.length === 0) {
          firstId = id
        }
      }
    }
    if (firstId.length === 0) {
      return false
    }
    this.saveServers(list, firstId)
    return true
  }
}