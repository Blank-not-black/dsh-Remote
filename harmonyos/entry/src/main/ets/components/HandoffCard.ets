import { HandoffState } from '../models/HandoffState'
import { Theme, Design } from '../models/Theme'
import { SessionView } from '../models/SessionView'
import { I18n } from '../common/I18n'

/** 接续卡片参数（显式类满足 arkts-no-untyped-obj-literals，风格对齐 SessionMenuParams） */
export class HandoffCardParams {
  handoff: HandoffState | null = null
  /** 命中的会话（用于展示状态胶囊；可能已被归档/清理，null 只显示标题） */
  session: SessionView | null = null
  /** 深浅判定（调用侧经 getDark 闭包读取 @StorageLink，建立渲染依赖） */
  getDark: () => boolean = () => false
  getAccent: () => string = () => '#0A59F7'
  onOpen: () => void = () => { }
  onDismiss: () => void = () => { }
}

/**
 * 跨端接续卡片：显示"另一台设备最近打开的会话"，点击直接跳入。
 * 数据来自网关 /handoff（另一设备离开会话时写入）。
 * 手机会话列表与平板侧栏共用同一 Builder，保证两端观感/交互一致。
 */
@Builder
export function handoffCard(p: HandoffCardParams) {
  Row({ space: 10 }) {
    Image($r('app.media.ic_message'))
      .width(18)
      .height(18)
      .fillColor(p.getAccent())
    Column({ space: 2 }) {
      Row({ space: 6 }) {
        Text(I18n.t('接着看', 'Continue'))
          .fontSize(11)
          .fontWeight(FontWeight.Medium)
          .fontColor(p.getAccent())
        if (p.session && p.session.running) {
          Circle({ width: 6, height: 6 }).fill(Design.SUCCESS)
        }
      }
      Text(p.handoff ? (p.handoff.title.length > 0 ? p.handoff.title : I18n.t('未命名会话', 'Untitled session')) : '')
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor(Design.TEXT_MAIN(p.getDark()))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      Text(handoffSubtitle(p.handoff))
        .fontSize(11)
        .fontColor(Design.TEXT_HINT(p.getDark()))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .alignItems(HorizontalAlign.Start)
    .layoutWeight(1)

    // 不再提示：清掉网关上的指针（下一次另一设备打开会话时会重新出现）
    Text(I18n.t('忽略', 'Dismiss'))
      .fontSize(12)
      .fontColor(Design.TEXT_HINT(p.getDark()))
      .padding({ left: 8, right: 8, top: 6, bottom: 6 })
      .onClick(() => {
        p.onDismiss()
      })
  }
  .width('100%')
  .padding({ left: 14, right: 10, top: 10, bottom: 10 })
  .backgroundColor(Design.selectedBg(p.getAccent()))
  .borderRadius(Design.RADIUS_CARD)
  .border({
    width: 1.5,
    color: p.getAccent()
  })
  .alignItems(VerticalAlign.Center)
  .onClick(() => {
    p.onOpen()
  })
}

/** 卡片第三行文案：设备名 + 相对时间（如 "HUAWEI Mate 60 Pro · 5 分钟前"） */
function handoffSubtitle(h: HandoffState | null): string {
  if (!h) {
    return ''
  }
  const parts: string[] = []
  if (h.device.length > 0) {
    parts.push(h.device)
  }
  const rel = handoffRelativeTime(h.at)
  if (rel.length > 0) {
    parts.push(rel)
  }
  return parts.join(' · ')
}

/** 相对时间（分钟级即可：刚更新 / N 分钟前 / N 小时前） */
function handoffRelativeTime(at: number): string {
  if (at <= 0) {
    return ''
  }
  const diff = Date.now() - at
  if (diff < 0 || diff < 60000) {
    return I18n.t('刚刚', 'now')
  }
  if (diff < 3600000) {
    return Math.floor(diff / 60000).toString() + I18n.t(' 分钟前', 'm ago')
  }
  return Math.floor(diff / 3600000).toString() + I18n.t(' 小时前', 'h ago')
}
