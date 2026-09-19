import { SessionView } from '../models/SessionView'
import { Design } from '../models/Theme'
import { I18n } from '../common/I18n'

/**
 * 会话长按菜单参数（显式类满足 arkts-no-untyped-obj-literals）。
 */
export class SessionMenuParams {
  /** 目标会话 */
  item: SessionView = new SessionView()
  /** 深浅判定（调用侧从 @StorageLink 传入，建立调用方渲染依赖） */
  dark: boolean = false
  /** 当前会话是否已归档（调用侧读 appState 传入） */
  archived: boolean = false
  /** 动作回调（确认弹窗/RPC 留给调用方，本 Builder 只管菜单 UI） */
  onArchive: () => void = () => {
  }
  onUnarchive: () => void = () => {
  }
}

/**
 * 会话长按菜单（手机端 SessionsPage 与平板端 TabletSidebar 共用）：
 * 归档/取消归档（按当前归档态二选一）。
 *
 * 删除项暂时隐藏：DSH 上游 RPC 面没有 session.delete，点击必然报
 * "方法不存在"；待上游提供后在此加一行 SessionActions.confirmDelete
 * 入口即可（确认弹窗已就绪，见 common/SessionActions）。
 *
 * 全局 @Builder 函数（非 @Component）：bindContextMenu 的 content 形参
 * 是 CustomBuilder（builder 函数），组件实例不能直接作该参数——
 * 调用形如 bindContextMenu(sessionMenu({...}), ResponseType.LongPress, ...)。
 */
@Builder
export function sessionMenu(p: SessionMenuParams) {
  Column() {
    if (p.archived) {
      menuRow(p, I18n.t('取消归档', 'Unarchive'), $r('app.media.ic_back'), false, () => {
        p.onUnarchive()
      })
    } else {
      menuRow(p, I18n.t('归档会话', 'Archive'), $r('app.media.ic_folder'), false, () => {
        p.onArchive()
      })
    }
  }
  .width(168)
  .borderRadius(Design.RADIUS_CONTROL)
  .backgroundColor(Design.SURFACE(p.dark))
  .shadow(Design.cardShadow(p.dark))
  .clip(true)
}

/** 菜单行（图标 + 文字），danger 为 true 时红色警示 */
@Builder
function menuRow(p: SessionMenuParams, label: string, icon: Resource, danger: boolean, onPick: () => void) {
  Row({ space: 8 }) {
    Image(icon)
      .width(16)
      .height(16)
      .fillColor(danger ? Design.DANGER : Design.TEXT_MAIN(p.dark))
    Text(label)
      .fontSize(14)
      .fontColor(danger ? Design.DANGER : Design.TEXT_MAIN(p.dark))
  }
  .width('100%')
  .padding({ left: 12, right: 16, top: 10, bottom: 10 })
  .onClick(() => {
    onPick()
  })
}
