/**
 * DSH Remote HarmonyOS 客户端常量
 */
export class Constants {
  /** hilog 域名（必须非 0，否则日志会被丢弃） */
  static readonly LOG_DOMAIN: number = 0xD004201
  /** hilog 标签 */
  static readonly LOG_TAG: string = 'DSHRemote'

  /** preferences 库名 */
  static readonly STORAGE_NAME: string = 'dsh_remote'
  /** 服务器列表 key（与 Web 端 servers-v2 概念对齐） */
  static readonly KEY_SERVERS: string = 'servers_v2'
  /** 当前服务器 id */
  static readonly KEY_ACTIVE_SERVER_ID: string = 'active_server_id'
  /** 客户端标识 id（网关设备识别用） */
  static readonly KEY_CLIENT_ID: string = 'client_id'
  /** 通知开关 */
  static readonly KEY_NOTIFY: string = 'notify_enabled'
  /** 主题 id */
  static readonly KEY_THEME: string = 'theme'
  /** 默认主题 */
  static readonly DEFAULT_THEME: string = 'deep-space'
  /** 深色模式：system 跟随系统 / light 常浅 / dark 常深 */
  static readonly KEY_DARK_MODE: string = 'dark_mode'
  static readonly DARK_SYSTEM: string = 'system'
  static readonly DARK_LIGHT: string = 'light'
  static readonly DARK_DARK: string = 'dark'
  /** 公告已读/投票记录 */
  static readonly KEY_ANN_SEEN: string = 'seenAnnouncementsV1'
  static readonly KEY_ANN_VOTES: string = 'announcementVotesV1'
  /** 已收公告的本地历史（与 Web 端 announcementHistoryV1 同 key 同语义） */
  static readonly KEY_ANN_HISTORY: string = 'announcementHistoryV1'
  /** 公告轮询间隔（毫秒），与 Web 端 ANNOUNCEMENTS_POLL_MS 一致 */
  static readonly ANN_POLL_MS: number = 30000
  /** 后台轮询间隔（分钟，可配；默认 0.5 对齐 Android 端 intervalMin） */
  static readonly KEY_BG_INTERVAL_MIN: string = 'bg_interval_min'
  static readonly DEFAULT_BG_INTERVAL_MIN: number = 0.5
  /** 项目发布页（应用内更新弹窗跳转用） */
  static readonly RELEASE_PAGE: string = 'https://github.com/Blank-not-black/dsh-Remote/releases/latest'
  /** 应用版本（与根 package.json 对齐） */
  static readonly APP_VERSION: string = '0.6.26'
  /** 后台轮询开关 */
  static readonly KEY_BG_POLL: string = 'background_poll'
  /** 后台轮询：令牌失效标记（连续 401 后置位，设置页提示重新配对） */
  static readonly KEY_LOGIN_EXPIRED: string = 'login_expired'
  /** 后台轮询：连续 401 多少次后停止并置位 */
  static readonly AUTH_FAIL_LIMIT: number = 3
  /** 长时任务刷新间隔（毫秒）：DATA_TRANSFER 超过约 10 分钟不更新进度会被系统取消 */
  static readonly CONTINUOUS_REFRESH_MS: number = 5 * 60 * 1000
  /** 上次后台轮询时长时任务是否获批（'1' 获批 / '0' 未获批 / '' 未跑过） */
  static readonly KEY_CONTINUOUS_STATE: string = 'continuous_state'
  /** 峰谷提醒开关 */
  static readonly KEY_PEAK_REMIND: string = 'peak_remind'
  /** 峰谷提醒进程内兜底的去重标记前缀（值 = yyyy-MM-dd） */
  static readonly KEY_PEAK_LAST_PREFIX: string = 'peak_last_fired_'
  /** 桌面卡片数据快照（主进程 BackgroundService 写，FormExtension 进程读） */
  static readonly KEY_FORM_STATE: string = 'form_state_v1'
  /** 实况窗开关（任务运行时在锁屏/状态栏展示进度胶囊） */
  static readonly KEY_LIVE_VIEW: string = 'live_view_enabled'
  /** 实况窗会话标题快照（跨进程恢复 stopLiveView 用） */
  static readonly KEY_LIVEVIEW_TITLE: string = 'liveview_title'
  /** 长按插队发送开关（对齐 Web 端 steerSendingEnabled，默认关） */
  static readonly KEY_STEER_SEND: string = 'steer_sending_enabled'
  /** 繁忙时默认发送方式：queue=排队（默认）/ steer=插队（对齐 Web 端 busySendMode） */
  static readonly KEY_BUSY_SEND_MODE: string = 'busy_send_mode'

  /** 网关默认端口 */
  static readonly DEFAULT_GATEWAY_PORT: number = 8787
  /** 长按插队手势：长按判定时长（毫秒，对齐 Web 端 450ms） */
  static readonly STEER_HOLD_MS: number = 450
  /** 长按插队提交后等待 DSH 确认的提醒阈值（毫秒，对齐 Web 端 3s） */
  static readonly STEER_SLOW_MS: number = 3000
  /** WS 连接时的客户端标记 */
  static readonly WS_CLIENT_MARK: string = 'app'
  /** RPC 默认超时（毫秒） */
  static readonly RPC_TIMEOUT_MS: number = 45000
  /** 轮询间隔（毫秒） */
  static readonly POLL_INTERVAL_MS: number = 4000
  /** 轮询模式尝试恢复 WS 的间隔（毫秒） */
  static readonly WS_RESTORE_INTERVAL_MS: number = 30000
  /** 任一通道连续失败达到该次数后降级轮询 */
  static readonly POLL_FAILURE_THRESHOLD: number = 3
  /** 统计天数 */
  static readonly STATS_DAYS: number = 7

  /** 服务器默认分组名 */
  static readonly DEFAULT_GROUP: string = '默认'
}