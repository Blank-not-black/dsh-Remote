import { notificationManager } from '@kit.NotificationKit'
import { BusinessError } from '@kit.BasicServicesKit'
import { Logger } from '../common/Logger'
import { StorageService } from './StorageService'
import { I18n } from '../common/I18n'

/**
 * 本地通知：审批 / 提问到达时提醒（对应 Android 壳的通知能力）。
 * 首次使用会请求通知授权；失败只记录日志，不影响主流程。
 */
export class NotificationService {
  private static seq: number = 1

  /** 请求通知授权（设置页开关打开时调用） */
  static async requestPermission(): Promise<boolean> {
    const ctx = StorageService.getContext()
    try {
      const enabled = await notificationManager.isNotificationEnabled()
      if (enabled) {
        return true
      }
      if (ctx) {
        await notificationManager.requestEnableNotification(ctx)
        return true
      }
      return false
    } catch (e) {
      Logger.warn('notification permission failed: ' + (e as BusinessError).message)
      return false
    }
  }

  /** 发本地通知；返回是否发布成功（峰谷提醒按此回滚去重标记） */
  static async notify(title: string, text: string): Promise<boolean> {
    const id = NotificationService.seq++
    const normal: notificationManager.NotificationBasicContent = {
      title: title,
      text: text
    }
    const request: notificationManager.NotificationRequest = {
      id: id,
      content: {
        notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
        normal: normal
      }
    }
    try {
      await notificationManager.publish(request)
      return true
    } catch (e) {
      Logger.warn('notification publish failed: ' + (e as BusinessError).message)
      return false
    }
  }

  /** 工具审批提醒 */
  static async notifyApproval(toolName: string): Promise<void> {
    await NotificationService.notify(I18n.t('需要审批', 'Approval needed'), I18n.t('工具 ' + toolName + ' 正在等待你的允许或拒绝', 'Tool ' + toolName + ' is waiting for your approval'))
  }

  /** 提问提醒 */
  static async notifyQuestion(question: string): Promise<void> {
    const text = question.length > 0 ? question : I18n.t('DSH 正在等待你的回答', 'DSH is waiting for your reply')
    await NotificationService.notify(I18n.t('有待回答的提问', 'Question pending'), text)
  }

  /** 任务完成 / 出错提醒（对应 Android RemotePollService 的 notify_task_done） */
  static async notifyTaskDone(sessionTitle: string, detail: string): Promise<void> {
    const text = sessionTitle.length > 0 ? sessionTitle + '：' + detail : detail
    await NotificationService.notify(I18n.t('任务已结束', 'Task finished'), text)
  }
}