import { liveViewManager } from '@kit.LiveViewKit'
import { wantAgent, Want, WantAgent } from '@kit.AbilityKit'
import { BusinessError } from '@kit.BasicServicesKit'
import { I18n } from '../common/I18n'
import { Logger } from '../common/Logger'
import { Constants } from '../common/Constants'
import { StorageService } from './StorageService'

/**
 * 实况窗封装（Live View Kit，官方 liveview-create-locally 模式）：
 * 会话任务运行时在锁屏/通知中心/状态栏胶囊展示「任务运行中」，结束自动收起。
 *
 * - 场景取 PROGRESS（进度类型）：官方场景表中「用户手动开启的任务进度提醒」，
 *   AI 会话任务由用户发送消息触发，语义最接近；
 * - 模板用 LAYOUT_TYPE_DEFAULT（不显示扩展区）：最简形态，无需 rawfile 图标资源，
 *   锁屏/通知中心/状态栏胶囊全部生效；
 * - PrimaryData 的 clickAction 创建时必填（官方表），用 wantAgent 指回 EntryAbility；
 * - 本地创建要求应用在前台（ChatView 发送消息时触发，天然满足前台条件）；
 * - 权益说明：实况窗为 AGC 权益管控能力，未开通权益时 startLiveView 会抛错，
 *   本服务全部 try/catch 吞掉并记日志，不影响应用主流程（优雅降级）。
 */
export class LiveViewService {
  private static view: liveViewManager.LiveView | null = null
  private static liveId: number = 26001

  static isEnabled(): boolean {
    return StorageService.getString(Constants.KEY_LIVE_VIEW, '1') === '1'
  }

  static setEnabled(on: boolean): void {
    StorageService.putString(Constants.KEY_LIVE_VIEW, on ? '1' : '0')
    if (!on) {
      LiveViewService.stop('user off')
    }
  }

  /** 任务开始（agent/status running=true 或发消息）：创建/复用实况窗 */
  static async start(title: string): Promise<void> {
    if (!LiveViewService.isEnabled()) {
      return
    }
    try {
      if (LiveViewService.view !== null) {
        // 已有窗：更新标题
        LiveViewService.view.liveViewData.primary.title = I18n.t('任务运行中', 'Task running')
        LiveViewService.view.liveViewData.primary.content = [{ text: LiveViewService.tail(title) }]
        await liveViewManager.updateLiveView(LiveViewService.view)
        return
      }
      const enabled = await liveViewManager.isLiveViewEnabled()
      if (!enabled) {
        Logger.info('liveview disabled by system switch')
        return
      }
      const view: liveViewManager.LiveView = {
        id: LiveViewService.liveId,
        event: 'PROGRESS',
        isMute: true,
        liveViewData: {
          primary: {
            title: I18n.t('任务运行中', 'Task running'),
            content: [{ text: LiveViewService.tail(title) }],
            keepTime: 10,
            clickAction: await LiveViewService.buildClickAction(),
            layoutData: {
              layoutType: liveViewManager.LayoutType.LAYOUT_TYPE_DEFAULT
            }
          }
        }
      }
      LiveViewService.view = view
      await liveViewManager.startLiveView(view)
      // 落盘标题：进程被杀后重启可据此判断是否有遗留窗
      StorageService.putString(Constants.KEY_LIVEVIEW_TITLE, title)
      Logger.info('liveview started')
    } catch (e) {
      const err = e as BusinessError
      // 权益未开通等业务错误一律吞掉，优雅降级
      Logger.warn('liveview start failed: ' + err.code.toString() + ' ' + err.message)
      LiveViewService.view = null
    }
  }

  /** 任务结束：收起实况窗（keepTime 秒内在通知中心保留结束态） */
  static async stop(reason: string): Promise<void> {
    if (LiveViewService.view === null) {
      return
    }
    try {
      await liveViewManager.stopLiveView(LiveViewService.view)
      Logger.info('liveview stopped: ' + reason)
    } catch (e) {
      const err = e as BusinessError
      Logger.warn('liveview stop failed: ' + err.code.toString() + ' ' + err.message)
    }
    LiveViewService.view = null
  }

  /** 构造点击实况窗回应用主站的 WantAgent */
  private static async buildClickAction(): Promise<Want> {
    const info: wantAgent.WantAgentInfo = {
      wants: [{
        bundleName: 'com.dshremote.app',
        abilityName: 'EntryAbility'
      }],
      actionType: wantAgent.OperationType.START_ABILITIES,
      requestCode: 0,
      actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    }
    const agent: WantAgent = await wantAgent.getWantAgent(info)
    return agent as Want
  }

  /** 标题过长截断（实况窗胶囊空间有限） */
  private static tail(title: string): string {
    if (title.length <= 24) {
      return title
    }
    return '…' + title.substring(title.length - 23)
  }
}
