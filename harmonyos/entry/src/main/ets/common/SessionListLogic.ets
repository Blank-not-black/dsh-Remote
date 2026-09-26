import { SessionView } from '../models/SessionView'
import { WorkspaceGroup } from '../models/WorkspaceGroup'
import { Design } from '../models/Theme'

/**
 * 会话列表共享逻辑：手机端 SessionsPage 与平板端 TabletSidebar 的
 * 分组/收放/配色规则同源（此前两端各写一份，改规则要改两处）。
 *
 * - groups()：按视图过滤（手机端有「已归档」视图，平板端恒为默认视图）
 *   后按 cwd 分组（WorkspaceGroup.build）
 * - 收放：isCollapsedIn / toggleInto 纯函数 + 「有运行中会话的组强制展开」
 *   规则；收放 keys 由页面 @State 持有（见下）
 * - statusColor：运行中绿 / 空白警示 / 空闲灰
 *
 * 响应式注意（真机踩坑）：收放状态此前挂在本类实例的普通属性上——普通
 * 实例属性变更不推送 UI，点分组头无任何重渲染、分组无法收放。本类因此
 * 不持有状态，只提供纯函数：入参取当前 keys，返回新数组，由调用方写回
 * 页面 @State 触发渲染。UI 形态差异（卡片 vs 单行、分组头字号）仍留两端
 * 各自的 @Builder。
 */
export class SessionListLogic {
  /** 分组数据：showArchived=false 隐藏已归档，true 只显示已归档（平板侧栏恒传 false） */
  groups(sessions: SessionView[], archivedIds: string[], showArchived: boolean): WorkspaceGroup[] {
    const archived = new Set<string>(archivedIds)
    const visible = sessions.filter((s: SessionView) => archived.has(s.sessionId) === showArchived)
    return WorkspaceGroup.build(visible)
  }

  /** 分组是否收起（纯函数）；有运行中会话的组始终视为展开 */
  static isCollapsedIn(keys: string[], g: WorkspaceGroup, sessions: SessionView[]): boolean {
    if (sessions.some((s: SessionView) => s.running)) {
      return false
    }
    return keys.indexOf(g.key) >= 0
  }

  /** 收放切换（纯函数）：返回新 keys 数组供调用方写回 @State（animateTo 由调用侧包裹） */
  static toggleInto(keys: string[], g: WorkspaceGroup, sessions: SessionView[]): string[] {
    if (sessions.some((s: SessionView) => s.running)) {
      return keys
    }
    const idx = keys.indexOf(g.key)
    if (idx >= 0) {
      const next = keys.slice()
      next.splice(idx, 1)
      return next
    }
    return [...keys, g.key]
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
