import { notificationManager } from '@kit.NotificationKit'
import { reminderAgentManager } from '@kit.BackgroundTasksKit'
import { BusinessError } from '@kit.BasicServicesKit'
import { Logger } from '../common/Logger'
import { StorageService } from './StorageService'
import { NotificationService } from './NotificationService'
import { Constants } from '../common/Constants'
import { I18n } from '../common/I18n'

/**
 * 峰谷计费提醒（对应 Android PeakReminderService）。
 *
 * 平台方案差异（Android 用前台服务进程内定时，MIUI 会掐 setRepeating 本地通知）：
 *   HarmonyOS 正统方案是「代理提醒」——应用被冻结/退出后由系统服务代理定时，
 *   无需常驻前台服务。提醒类型取「闹钟」（REMINDER_TYPE_ALARM，按 hour/minute
 *   + daysOfWeek 每周重复），四个时段各一条；周末全天谷时 → 只保留 9 点一条、
 *   daysOfWeek 限周六周日，与 Android 端"周末仅 09:00 提醒一次"语义一致。
 *
 * 管控与降级（官方约束，见 agent-powered-reminder「约束与限制」）：
 *   手机设备上代理提醒存在管控，未获开放能力授权的普通应用发布时返回
 *   1700002（提醒数量上限视为 0）。本应用侧载分发、不上架，无法走 AGC
 *   开放能力申请，因此 publish 失败时自动降级为进程内定时器兜底（应用
 *   活着时照常提醒；冻结期间无提醒，设置页会注明此限制）。
 *
 * 文档出处：
 *   https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/agent-powered-reminder
 *   https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-reminderagentmanager
 */

/** 时段定义（与 Android 端 SLOTS 对齐）；文案双语（zh/en 字段，发布时按系统语言取） */
interface PeakSlot {
  /** 槽位标识（存储键用，对应 Android 的通知 id 8801-8804） */
  key: string
  hour: number
  minute: number
  /** 工作日文案 */
  weekdayText: string
  weekdayTextEn: string
  /** 周末该槽是否仍提醒（周末只在 9 点提醒一次） */
  weekendActive: boolean
}

const PEAK_SLOTS: PeakSlot[] = [
  { key: '9', hour: 9, minute: 0, weekdayText: '进入峰时 9:00-12:00', weekdayTextEn: 'Peak 9:00-12:00 begins', weekendActive: true },
  { key: '12', hour: 12, minute: 0, weekdayText: '进入谷时 12:00-14:00', weekdayTextEn: 'Valley 12:00-14:00 begins', weekendActive: false },
  { key: '14', hour: 14, minute: 0, weekdayText: '进入峰时 14:00-18:00', weekdayTextEn: 'Peak 14:00-18:00 begins', weekendActive: false },
  { key: '18', hour: 18, minute: 0, weekdayText: '进入谷时 18:00-次日 9:00', weekdayTextEn: 'Valley 18:00-next day 9:00 begins', weekendActive: false }
]

const WEEKEND_TEXT_ZH = '今天是周末，谷时已到'
const WEEKEND_TEXT_EN = 'Weekend today: valley time all day'

/** 按系统语言取时段文案（发布时求值，避免模块加载期语言未初始化） */
function slotText(slot: PeakSlot): string {
  return I18n.isZh() ? slot.weekdayText : slot.weekdayTextEn
}

function weekendText(): string {
  return I18n.isZh() ? WEEKEND_TEXT_ZH : WEEKEND_TEXT_EN
}

/** 进程内兜底定时器轮询间隔（毫秒），对齐 Android 端 CHECK_INTERVAL_MS */
const CHECK_INTERVAL_MS = 30000
/** 补发窗口：定时器被系统延后仍可补发最近一次切换（秒），对齐 Android 端 */
const CATCH_UP_WINDOW_SECONDS = 30 * 60

/** 通知 id：与 Android 端 8801-8804 对齐，避免多端同装时通知语义混乱 */
function slotNotificationId(slot: PeakSlot): number {
  return 8800 + Number(slot.key)
}

export class PeakReminderService {
  private static timer: number = -1
  /** true = 系统代理提醒可用；false = 已降级为进程内定时器 */
  private static agentMode: boolean = false

  /**
   * 模式落 AppStorage 原语（'agent' | 'fallback' | ''）：
   * 设置页副标题 @StorageLink 绑定它，模式降级/恢复时即时刷新
   * （agentMode 是普通静态属性，变更不推送 UI）。
   */
  private static syncModeStorage(): void {
    AppStorage.setOrCreate('peakMode', PeakReminderService.agentMode ? 'agent' : 'fallback')
  }

  static isRunning(): boolean {
    return PeakReminderService.timer >= 0 || PeakReminderService.agentMode
  }

  static isAgentMode(): boolean {
    return PeakReminderService.agentMode
  }

  /**
   * 应用启动恢复（AppState.init 调用，静默、不弹授权）：
   * 系统代理提醒按 notificationId 查询——5 条槽位齐全说明此前走代理模式，
   * 直接复用（代理提醒由系统常驻，无需重复发布）；缺失则补发一次；
   * 发布失败（管控）降级为进程内定时器。
   */
  static async restore(enabled: boolean): Promise<void> {
    if (!enabled || PeakReminderService.agentMode || PeakReminderService.timer >= 0) {
      return
    }
    let found = 0
    try {
      const valid = await reminderAgentManager.getValidReminders()
      for (const r of valid) {
        if ((r.notificationId ?? 0) >= 8801 && (r.notificationId ?? 0) <= 8810) {
          found++
        }
      }
    } catch (e) {
      Logger.warn('peak getValidReminders failed: ' + (e as BusinessError).message)
    }
    if (found >= PEAK_SLOTS.length + 1) {
      PeakReminderService.agentMode = true
      PeakReminderService.syncModeStorage()
      Logger.info('peak reminder agent mode (restored)')
      return
    }
    await PeakReminderService.stop()
    const agentOk = await PeakReminderService.startAgent()
    if (agentOk) {
      PeakReminderService.agentMode = true
      PeakReminderService.syncModeStorage()
      Logger.info('peak reminder agent mode (republished)')
      return
    }
    PeakReminderService.agentMode = false
    PeakReminderService.syncModeStorage()
    PeakReminderService.startFallback()
    Logger.info('peak reminder fallback timer mode (restored)')
  }

  /**
   * 开启峰谷提醒：先尝试发布 5 条代理提醒（4 条工作日 + 1 条周末），
   * 全部成功走系统代理；任一失败（典型 1700002 管控）清掉已发布的
   * 并降级为进程内定时器。返回是否成功开启（两种模式都算成功）。
   */
  static async start(): Promise<boolean> {
    await PeakReminderService.stop()
    const agentOk = await PeakReminderService.startAgent()
    if (agentOk) {
      PeakReminderService.agentMode = true
      PeakReminderService.syncModeStorage()
      Logger.info('peak reminder agent mode')
      return true
    }
    PeakReminderService.agentMode = false
    PeakReminderService.syncModeStorage()
    PeakReminderService.startFallback()
    Logger.info('peak reminder fallback timer mode')
    return true
  }

  static async stop(): Promise<void> {
    PeakReminderService.stopFallback()
    await PeakReminderService.cancelAgent()
    PeakReminderService.agentMode = false
    PeakReminderService.syncModeStorage()
  }

  // ---------------- 系统代理提醒 ----------------

  private static async startAgent(): Promise<boolean> {
    try {
      const slot: notificationManager.NotificationSlot = {
        notificationType: notificationManager.SlotType.SOCIAL_COMMUNICATION
      }
      await reminderAgentManager.addNotificationSlot(slot)
    } catch (e) {
      Logger.warn('peak addNotificationSlot failed: ' + (e as BusinessError).message)
    }
    for (const slot of PEAK_SLOTS) {
      try {
        const alarm: reminderAgentManager.ReminderRequestAlarm = {
          reminderType: reminderAgentManager.ReminderType.REMINDER_TYPE_ALARM,
          hour: slot.hour,
          minute: slot.minute,
          // daysOfWeek 空 = 每天；周末槽单独建，daysOfWeek 限周六(6)周日(7)
          daysOfWeek: [1, 2, 3, 4, 5],
          title: 'DSH Remote',
          content: slotText(slot),
          notificationId: slotNotificationId(slot),
          wantAgent: {
            pkgName: 'com.dshremote.app',
            abilityName: 'EntryAbility'
          },
          slotType: notificationManager.SlotType.SOCIAL_COMMUNICATION
        }
        await reminderAgentManager.publishReminder(alarm)
      } catch (e) {
        const err = e as BusinessError
        Logger.warn('peak publish ' + slot.key + ' failed: ' + err.code + ' ' + err.message)
        await PeakReminderService.cancelAgent()
        return false
      }
    }
    try {
      const weekend: reminderAgentManager.ReminderRequestAlarm = {
        reminderType: reminderAgentManager.ReminderType.REMINDER_TYPE_ALARM,
        hour: 9,
        minute: 0,
        daysOfWeek: [6, 7],
        title: 'DSH Remote',
        content: weekendText(),
        notificationId: 8810,
        wantAgent: {
          pkgName: 'com.dshremote.app',
          abilityName: 'EntryAbility'
        },
        slotType: notificationManager.SlotType.SOCIAL_COMMUNICATION
      }
      await reminderAgentManager.publishReminder(weekend)
    } catch (e) {
      const err = e as BusinessError
      Logger.warn('peak publish weekend failed: ' + err.code + ' ' + err.message)
      await PeakReminderService.cancelAgent()
      return false
    }
    return true
  }

  private static async cancelAgent(): Promise<void> {
    try {
      await reminderAgentManager.cancelAllReminders()
    } catch (e) {
      Logger.warn('peak cancelAllReminders failed: ' + (e as BusinessError).message)
    }
  }

  // ---------------- 进程内兜底定时器 ----------------

  private static startFallback(): void {
    PeakReminderService.timer = setInterval(() => {
      PeakReminderService.checkAndNotify()
    }, CHECK_INTERVAL_MS)
  }

  private static stopFallback(): void {
    if (PeakReminderService.timer >= 0) {
      clearInterval(PeakReminderService.timer)
      PeakReminderService.timer = -1
    }
  }

  /**
   * 进程内检查（对齐 Android checkAndNotify）：
   * 北京时间切换点后 CATCH_UP_WINDOW_SECONDS 内且当天未发过 → 发本地通知。
   * 去重标记先落盘再发，通知失败回滚，保证崩溃/重启不重复发送。
   */
  private static checkAndNotify(): void {
    const now = new Date()
    const beijing = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000)
    const nowSeconds = beijing.getHours() * 3600 + beijing.getMinutes() * 60 + beijing.getSeconds()
    const today = beijing.getFullYear().toString() + '-' +
      (beijing.getMonth() + 1).toString().padStart(2, '0') + '-' +
      beijing.getDate().toString().padStart(2, '0')
    const day = beijing.getDay()
    const weekend = day === 0 || day === 6

    for (const slot of PEAK_SLOTS) {
      if (weekend && !slot.weekendActive) {
        continue
      }
      const target = slot.hour * 3600 + slot.minute * 60
      if (nowSeconds < target || nowSeconds >= target + CATCH_UP_WINDOW_SECONDS) {
        continue
      }
      const dedupKey = Constants.KEY_PEAK_LAST_PREFIX + slot.key
      if (StorageService.getString(dedupKey, '') === today) {
        continue
      }
      // 先落去重标记再发，失败回滚（与 Android commit-then-notify 顺序一致）
      StorageService.putString(dedupKey, today)
      const text = weekend ? weekendText() : slotText(slot)
      NotificationService.notify('DSH Remote', text).then((ok: boolean): void => {
        if (!ok) {
          StorageService.deleteKey(dedupKey)
        }
      })
    }
  }
}
