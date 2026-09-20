import { SessionView } from '../models/SessionView'
import { Design } from '../models/Theme'
import { I18n } from './I18n'

/**
 * 会话操作确认弹窗：手机端 SessionsPage 与平板端 TabletSidebar 共用
 * （此前归档/删除确认在两端各写一份 AlertDialog，文案与按钮语义必须
 * 严格一致，抽到一处防止漂移）。
 *
 * 删除入口当前在两端的长按菜单中隐藏（DSH 上游无 session.delete RPC，
 * 见 Blank-not-black/dsh-Remote#11）；deleteSession 链路已就绪，上游
 * 提供后把 confirmDelete 挂回菜单即可，确认弹窗无需再写。
 */
export class SessionActions {
  /** 归档确认：归档后从列表移除（手机端可在「已归档」视图查看） */
  static confirmArchive(item: SessionView, onOk: () => void): void {
    AlertDialog.show({
      title: I18n.t('归档会话', 'Archive session'),
      message: I18n.t('归档「' + item.displayLabel() + '」？归档后从会话列表移除，可在"已归档"视图查看。', 'Archive ' + item.displayLabel() + '? It will leave the list; view it under Archived.'),
      primaryButton: { value: I18n.t('取消', 'Cancel'), action: () => { } },
      secondaryButton: {
        value: I18n.t('归档', 'Archive'),
        action: () => {
          onOk()
        }
      }
    })
  }

  /** 删除确认（不可恢复） */
  static confirmDelete(item: SessionView, onOk: () => void): void {
    AlertDialog.show({
      title: I18n.t('删除会话', 'Delete session'),
      message: I18n.t('删除「' + item.displayLabel() + '」？该操作不可恢复。', 'Delete ' + item.displayLabel() + '? This cannot be undone.'),
      primaryButton: { value: I18n.t('取消', 'Cancel'), action: () => { } },
      secondaryButton: {
        value: I18n.t('删除', 'Delete'),
        fontColor: Design.DANGER,
        action: () => {
          onOk()
        }
      }
    })
  }
}
