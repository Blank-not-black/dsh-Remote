import { SessionView } from '../models/SessionView'
import { WorkspaceGroup } from '../models/WorkspaceGroup'
import { Design } from '../models/Theme'

/**
 * 会话列表共享状态机：手机端 SessionsPage 与平板端 TabletSidebar 的
 * 分组/收放/配色逻辑同源（此前两端各写一份，改规则要改两处）。
 *
 * - groups()：按视图过滤（手机端有「已归档」视图，平板端恒为默认视图）
 *   后按 cwd 分组（WorkspaceGroup.build）
 * - 收放状态机：collapsedKeys 集合 + 「有运行中会话的组强制展开」规则
 * - statusColor：运行中绿 / 空白警示 / 空闲灰
 *
 * UI 形态差异（卡片 vs 单行、分组头字号）仍留两端各自的 @Builder；
 * 本类只承载纯逻辑，不持有组件状态引用。
 */
export class SessionListLogic {
  /** 收起的分组 key 集合（默认全部展开；有运行中会话的组强制展开） */
  collapsedKeys: string[] = []

  /** 分组数据：showArchived=false 隐藏已归档，true 只显示已归档（平板侧栏恒传 false） */
  groups(sessions: SessionView[], archivedIds: string[], showArchived: boolean): WorkspaceGroup[] {
    const archived = new Set<string>(archivedIds)
    const visible = sessions.filter((s: SessionView) => archived.has(s.sessionId) === showArchived)
    return WorkspaceGroup.build(visible)
  }

  /** 分组是否收起；有运行中会话的组始终视为展开 */
  isCollapsed(g: WorkspaceGroup, sessions: SessionView[]): boolean {
    if (sessions.some((s: SessionView) => s.running)) {
      return false
    }
    return this.collapsedKeys.indexOf(g.key) >= 0
  }

  /** 收放切换：返回值供调用方包进 animateTo（transition 动画由调用侧驱动） */
  toggleGroup(g: WorkspaceGroup, sessions: SessionView[]): void {
    if (sessions.some((s: SessionView) => s.running)) {
      return
    }
    const idx = this.collapsedKeys.indexOf(g.key)
    if (idx >= 0) {
      const next = this.collapsedKeys.slice()
      next.splice(idx, 1)
      this.collapsedKeys = next
    } else {
      this.collapsedKeys = [...this.collapsedKeys, g.key]
    }
  }

  /** 状态点颜色：运行中绿 / 空白警示 / 空闲灰 */
  static statusColor(item: SessionView, dark: boolean): string {
    if (item.running) {
      return Design.SUCCESS
    }
    if (item.blank) {
      return Design.WARNING
    }
    return Design.TEXT_HINT(dark)
  }
}
