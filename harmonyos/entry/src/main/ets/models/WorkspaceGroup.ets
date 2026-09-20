import { SessionView } from './SessionView'
import { I18n } from '../common/I18n'

/**
 * 工作区分组：cwd → 组名 + 组内会话（按更新时间倒序）。
 * 手机端 SessionsPage 与平板端 TabletSidebar 共用同一分组规则。
 */
export class WorkspaceGroup {
  /** 分组 key（完整 cwd，去尾分隔符） */
  key: string = ''
  /** 显示名：路径末段 */
  name: string = ''
  sessions: SessionView[] = []

  static build(sessions: SessionView[]): WorkspaceGroup[] {
    const order: string[] = []
    const map: Map<string, WorkspaceGroup> = new Map()
    for (const s of sessions) {
      const key = WorkspaceGroup.keyOf(s)
      let g = map.get(key)
      if (!g) {
        g = new WorkspaceGroup()
        g.key = key
        g.name = WorkspaceGroup.nameOf(s)
        map.set(key, g)
        order.push(key)
      }
      g.sessions.push(s)
    }
    const out: WorkspaceGroup[] = []
    for (const k of order) {
      const g = map.get(k)
      if (g) {
        // 组内按更新时间倒序
        g.sessions.sort((a: SessionView, b: SessionView) => b.updatedAt - a.updatedAt)
        out.push(g)
      }
    }
    return out
  }

  /** 分组 key：cwd 去尾分隔符；空 cwd 归入未分组 */
  private static keyOf(s: SessionView): string {
    const raw = s.cwd.trim()
    if (raw.length === 0) {
      return ''
    }
    return raw.replace(/[\\/]+$/, '')
  }

  /** 组名：cwd 末段；未分组返回固定文案 */
  private static nameOf(s: SessionView): string {
    const key = WorkspaceGroup.keyOf(s)
    if (key.length === 0) {
      return I18n.t('未指定工作区', 'No workspace')
    }
    const parts = key.split(/[\\/]/)
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].length > 0) {
        return parts[i]
      }
    }
    return key
  }
}
