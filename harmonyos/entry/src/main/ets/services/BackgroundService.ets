import { common, wantAgent } from '@kit.AbilityKit'
import { backgroundTaskManager } from '@kit.BackgroundTasksKit'
import { GatewayApi } from './GatewayApi'
import { NotificationService } from './NotificationService'
import { LiveViewService } from './LiveViewService'
import { AppState } from './AppState'
import { StorageService } from './StorageService'
import { Constants } from '../common/Constants'
import { Logger } from '../common/Logger'
import { I18n } from '../common/I18n'

/**
 * 后台常驻：**长时任务（continuous task）** + 增量事件轮询。
 *
 * 与 Android 的差异说明：
 *   Android 用前台服务（FOREGROUND_SERVICE_DATA_SYNC）常驻；HarmonyOS 没有等价机制，
 *   只能用「长时任务」——但它**不发通知给前台服务用**，而是由系统弹一条常驻通知，
 *   且必须声明 backgroundModes 并被系统按场景审核。
 *
 * 平台约束（实测自 SDK 声明，见 @ohos.resourceschedule.backgroundTaskManager.d.ts）：
 *   - 长时任务是场景白名单制：DATA_TRANSFER / AUDIO_PLAYBACK / LOCATION / VOIP / TASK_KEEPING…
 *     没有"纯事件轮询"这一档，本应用取最接近的 dataTransfer。
 *   - DATA_TRANSFER 有硬性规则：**超过约 10 分钟不更新进度，系统会以
 *     SYSTEM_CANCEL_DATA_TRANSFER_LOW_SPEED 取消该任务**。因此 refreshContinuous()
 *     每 CONTINUOUS_REFRESH_MS 调一次 updateBackgroundRunning 保活。
 *   - 因此本服务在系统允许的窗口内尽力轮询；被系统取消时会记录原因（continuousTaskCancel）。
 *
 * 本应用为侧载分发（不发布应用商店），场景归类不涉及商店审核；若将来上架需重新评估。
 */
export class BackgroundService {
  private static running: boolean = false
  private static continuous: boolean = false
  private static continuousRegistered: boolean = false
  private static authFailures: number = 0
  private static lastRefreshAt: number = 0
  private static timer: number = -1
  private static ctx: common.UIAbilityContext | null = null
  private static seqMux: number = 0
  private static seqHost: number = 0

  static isRunning(): boolean {
    return BackgroundService.running
  }

  /** 长时任务是否已获批（false 表示退化为普通定时器，退后台可能被挂起） */
  static isContinuous(): boolean {
    return BackgroundService.continuous
  }

  static async start(ctx: common.UIAbilityContext): Promise<void> {
    if (BackgroundService.running) {
      return
    }
    const s = AppState.instance.server
    if (!s) {
      return
    }
    BackgroundService.ctx = ctx
    BackgroundService.running = true
    BackgroundService.authFailures = 0
    BackgroundService.seqMux = 0
    BackgroundService.seqHost = 0
    Logger.info('background poll start')

    BackgroundService.registerCancelListener()
    BackgroundService.continuous = await BackgroundService.enterContinuous(ctx)
    // 落盘供设置页展示（长时任务是否获批只能在退后台时得知）
    StorageService.putString(Constants.KEY_CONTINUOUS_STATE,
      BackgroundService.continuous ? '1' : '0')
    Logger.info('continuous task active=' + (BackgroundService.continuous ? '1' : '0'))

    BackgroundService.pollOnce()
    // setTimeout 链：每轮完成后再排下一轮，间隔取设置页配置（对齐 Android intervalMin）
    BackgroundService.scheduleNext()
  }

  static async stop(): Promise<void> {
    BackgroundService.running = false
    if (BackgroundService.timer >= 0) {
      clearTimeout(BackgroundService.timer)
      BackgroundService.timer = -1
    }
    await BackgroundService.exitContinuous()
    Logger.info('background poll stop')
  }

  /** 每轮完成后按配置间隔排下一轮（10s ~ 60min，默认 0.5 分钟） */
  private static scheduleNext(): void {
    if (!BackgroundService.running) {
      return
    }
    BackgroundService.timer = setTimeout(() => {
      BackgroundService.pollOnce()
      BackgroundService.scheduleNext()
    }, BackgroundService.pollIntervalMs())
  }

  /** 间隔毫秒：KEY_BG_INTERVAL_MIN * 60000，钳制 [10s, 60min] */
  private static pollIntervalMs(): number {
    const raw = Number(StorageService.getString(Constants.KEY_BG_INTERVAL_MIN,
      Constants.DEFAULT_BG_INTERVAL_MIN.toString()))
    const minutes = Number.isNaN(raw) || raw <= 0 ? Constants.DEFAULT_BG_INTERVAL_MIN : raw
    return Math.min(Math.max(minutes * 60000, 10000), 3600000)
  }

  // ---------------- 长时任务 ----------------

  /** 申请长时任务；失败返回 false（调用方按"尽力轮询"降级） */
  private static async enterContinuous(ctx: common.UIAbilityContext): Promise<boolean> {
    try {
      const info: wantAgent.WantAgentInfo = {
        wants: [{
          bundleName: ctx.abilityInfo.bundleName,
          abilityName: ctx.abilityInfo.name
        }],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 100,
        actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
      }
      const agent = await wantAgent.getWantAgent(info)
      const modes: string[] = ['dataTransfer']
      const info2 = await backgroundTaskManager.startBackgroundRunning(ctx, modes, agent)
      BackgroundService.lastRefreshAt = Date.now()
      Logger.info('continuous started id=' + info2.notificationId.toString())
      return true
    } catch (e) {
      Logger.warn('continuous start failed: ' + (e as Error).message)
      return false
    }
  }

  private static async exitContinuous(): Promise<void> {
    if (!BackgroundService.ctx) {
      return
    }
    try {
      await backgroundTaskManager.stopBackgroundRunning(BackgroundService.ctx)
      Logger.info('continuous stopped')
    } catch (e) {
      Logger.warn('continuous stop failed: ' + (e as Error).message)
    }
    BackgroundService.continuous = false
  }

  /**
   * DATA_TRANSFER 保活：超过约 10 分钟不更新进度会被系统取消，
   * 因此每 CONTINUOUS_REFRESH_MS 刷新一次。
   */
  private static async refreshContinuous(): Promise<void> {
    if (!BackgroundService.continuous || !BackgroundService.ctx) {
      return
    }
    const now = Date.now()
    if (now - BackgroundService.lastRefreshAt < Constants.CONTINUOUS_REFRESH_MS) {
      return
    }
    BackgroundService.lastRefreshAt = now
    try {
      const modes: string[] = ['dataTransfer']
      await backgroundTaskManager.updateBackgroundRunning(BackgroundService.ctx, modes)
      Logger.info('continuous refreshed')
    } catch (e) {
      Logger.warn('continuous refresh failed: ' + (e as Error).message)
      BackgroundService.continuous = false
    }
  }

  /** 记录系统/用户取消长时任务的原因，便于真机定位 */
  private static registerCancelListener(): void {
    if (BackgroundService.continuousRegistered) {
      return
    }
    BackgroundService.continuousRegistered = true
    try {
      backgroundTaskManager.on('continuousTaskCancel',
        (info: backgroundTaskManager.ContinuousTaskCancelInfo) => {
          Logger.warn('continuous cancelled reason=' + info.reason.toString() + ' id=' + info.id.toString())
          BackgroundService.continuous = false
        })
      backgroundTaskManager.on('continuousTaskSuspend',
        (info: backgroundTaskManager.ContinuousTaskSuspendInfo) => {
          Logger.warn('continuous suspended id=' + info.continuousTaskId.toString() +
            ' state=' + (info.suspendState ? '1' : '0') + ' reason=' + info.suspendReason.toString())
        })
      backgroundTaskManager.on('continuousTaskActive',
        (info: backgroundTaskManager.ContinuousTaskActiveInfo) => {
          Logger.info('continuous active id=' + info.id.toString())
        })
    } catch (e) {
      Logger.warn('continuous listener failed: ' + (e as Error).message)
    }
  }

  // ---------------- 轮询 ----------------

  private static async pollOnce(): Promise<void> {
    if (!BackgroundService.running) {
      return
    }
    const s = AppState.instance.server
    if (!s || s.token.length === 0) {
      return
    }
    await BackgroundService.refreshContinuous()
    BackgroundService.writeFormSnapshot()
    const base = s.normalizedUrl()
    const token = s.token
    await BackgroundService.pollKind('mux', base, token)
    await BackgroundService.pollKind('host', base, token)
  }

  /**
   * 把「网关状态 + 运行中会话数 + 最近会话标题」快照写进 Storage，
   * 桌面服务卡片（FormExtension 进程，独立于本进程内存态）读这份快照渲染。
   */
  private static writeFormSnapshot(): void {
    try {
      const sessions = AppState.instance.sessions
      let running = 0
      let latest = ''
      for (const s of sessions) {
        if (s.running) {
          running++
        }
        if (latest.length === 0 && s.displayTitle().length > 0) {
          latest = s.displayTitle()
        }
      }
      const h = AppState.instance.health
      const ok = h !== null && h.upstreamOk ? '1' : '0'
      const data: Record<string, string> = {
        'ok': ok,
        'running': running.toString(),
        'title': latest
      }
      StorageService.putString(Constants.KEY_FORM_STATE, JSON.stringify(data))
    } catch (e) {
      // 快照失败不影响轮询
    }
  }

  private static async pollKind(kind: string, base: string, token: string): Promise<void> {
    try {
      const since = kind === 'mux' ? BackgroundService.seqMux : BackgroundService.seqHost
      const data = await GatewayApi.pollEvents(base, token, kind, since)
      BackgroundService.authFailures = 0
      const events = data['events'] as Array<Record<string, Object>> ?? []
      for (const item of events) {
        const seq = Number(item['seq'] ?? 0)
        const ev = item['event'] as Record<string, Object>
        if (seq <= since || !ev) {
          continue
        }
        BackgroundService.handleFrame(ev)
        if (kind === 'mux') {
          BackgroundService.seqMux = seq
        } else {
          BackgroundService.seqHost = seq
        }
      }
    } catch (e) {
      const msg = (e as Error).message
      if (msg === 'AUTH') {
        // 连续 401：停止轮询并置位，由设置页提示重新配对
        // （对应 Android RemotePollService 的 login_expired 处理）
        BackgroundService.authFailures++
        if (BackgroundService.authFailures >= Constants.AUTH_FAIL_LIMIT) {
          Logger.warn('background poll auth failed ' + BackgroundService.authFailures.toString() + ' times, stop')
          StorageService.putString(Constants.KEY_LOGIN_EXPIRED, '1')
          await BackgroundService.stop()
        }
        return
      }
      // 其他失败静默，等待下一轮
    }
  }

  private static handleFrame(wrapper: Record<string, Object>): void {
    const payload = wrapper['payload'] as Record<string, Object>
    if (!payload) {
      return
    }
    const type = String(payload['type'] ?? '')
    if (type === 'approval/requested') {
      NotificationService.notifyApproval(String(payload['toolName'] ?? '工具'))
      return
    }
    if (type === 'question/requested') {
      const qs = payload['questions'] as Array<Record<string, Object>> ?? []
      const title = qs.length > 0 ? String(qs[0]['question'] ?? '') : ''
      NotificationService.notifyQuestion(title)
      return
    }
    // 任务结束：agent/status(false) 与 host 的会话状态变化
    // （对应 Android RemotePollService 的 notify_task_done）
    if (type === 'agent/status') {
      const data = payload['data'] as Record<string, Object> ?? {}
      const running = data['running'] as boolean
      if (running === true) {
        // 任务开始：实况窗展示「任务运行中 + 会话标题」（前台创建要求由 UIAbility 发消息路径满足，
        // 后台轮询路径里 start 幂等：已有窗只更新标题）
        LiveViewService.start(BackgroundService.sessionTitle(payload))
      } else if (running === false) {
        NotificationService.notifyTaskDone(BackgroundService.sessionTitle(payload), I18n.t('本轮已结束', 'Turn finished'))
        LiveViewService.stop('turn finished')
      }
      return
    }
    if (type === 'host/session-status') {
      const running = payload['running']
      if (running === false) {
        NotificationService.notifyTaskDone(BackgroundService.sessionTitle(payload), I18n.t('会话已空闲', 'Session idle'))
        LiveViewService.stop('session idle')
      }
      return
    }
    if (type === 'host/agent-error') {
      NotificationService.notifyTaskDone(BackgroundService.sessionTitle(payload), I18n.t('执行出错', 'Execution error'))
      LiveViewService.stop('agent error')
    }
  }

  /** 从事件里尽量取会话标题，取不到就返回空串 */
  private static sessionTitle(payload: Record<string, Object>): string {
    const sid = String(payload['sessionId'] ?? '')
    if (sid.length === 0) {
      return ''
    }
    for (const s of AppState.instance.sessions) {
      if (s.sessionId === sid) {
        return s.displayTitle()
      }
    }
    return ''
  }
}
