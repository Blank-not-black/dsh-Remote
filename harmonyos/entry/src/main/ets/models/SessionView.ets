/**
 * 会话列表显示模型（session.list 响应项的展示子集）。
 *
 * 契约（与 public/app.js 的 refreshSessions 保持一致）：
 *   RPC result.value = { items: [ { sessionId, updatedAt, running, blank, cwd,
 *                                   parentSessionId?, origin?, projections? } ] }
 * 标题不在顶层，而在 projections.values.title（新版 DSH 的按需投影）。
 * 顶层会话过滤：!parentSessionId && origin !== 'subagent'。
 */
import { I18n } from '../common/I18n'

export class SessionView {
  sessionId: string = ''
  title: string = ''
  running: boolean = false
  blank: boolean = false
  cwd: string = ''
  parentSessionId: string = ''
  origin: string = ''
  updatedAt: number = 0
  workspaceId: string = ''

  static fromRecord(r: Record<string, Object>): SessionView {
    const s = new SessionView()
    s.sessionId = String(r['sessionId'] ?? '')
    s.title = String(r['title'] ?? '')
    s.running = r['running'] as boolean ?? false
    s.blank = r['blank'] as boolean ?? false
    s.cwd = String(r['cwd'] ?? '')
    s.parentSessionId = String(r['parentSessionId'] ?? '')
    s.origin = String(r['origin'] ?? '')
    s.updatedAt = Number(r['updatedAt'] ?? 0)
    s.workspaceId = String(r['workspaceId'] ?? '')
    // 标题优先取 projections.values.title
    if (s.title.length === 0) {
      s.title = SessionView.projectionTitle(r)
    }
    return s
  }

  /** projections.values.title → 标题（缺失返回空串） */
  private static projectionTitle(r: Record<string, Object>): string {
    const proj = r['projections'] as Record<string, Object>
    if (!proj) {
      return ''
    }
    const values = proj['values'] as Record<string, Object>
    if (!values) {
      return ''
    }
    return String(values['title'] ?? '')
  }

  /**
   * session.list 的 result.value → 会话数组。
   * 兼容两种形态：{ items: [...] }（现行）与裸数组（旧版/兼容回退）。
   */
  static fromRpcValue(v: Object): SessionView[] {
    const list: SessionView[] = []
    if (v === null || v === undefined) {
      return list
    }
    let arr: Array<Record<string, Object>> | null = null
    if (Array.isArray(v)) {
      arr = v as Array<Record<string, Object>>
    } else {
      const rec = v as Record<string, Object>
      const items = rec['items']
      if (items !== null && items !== undefined && Array.isArray(items)) {
        arr = items as Array<Record<string, Object>>
      }
    }
    if (arr === null) {
      return list
    }
    for (const item of arr) {
      if (item === null || item === undefined) {
        continue
      }
      list.push(SessionView.fromRecord(item))
    }
    return list
  }

  /**
   * session.list 初始投影装载（对齐 Web 端 hydrateSessionProjections）。
   * put 回调逐会话下发 (sessionId, asOfSeq, 合并后的 values 拷贝)。
   */
  static hydrateProjections(v: Object,
    put: (sessionId: string, seq: number, values: Record<string, Object>) => void): void {
    if (v === null || v === undefined) {
      return
    }
    let arr: Array<Record<string, Object>> | null = null
    if (Array.isArray(v)) {
      arr = v as Array<Record<string, Object>>
    } else {
      const rec = v as Record<string, Object>
      const items = rec['items']
      if (items !== null && items !== undefined && Array.isArray(items)) {
        arr = items as Array<Record<string, Object>>
      }
    }
    if (arr === null) {
      return
    }
    for (const item of arr) {
      if (!item) {
        continue
      }
      const sid = String(item['sessionId'] ?? '')
      const proj = item['projections'] as Record<string, Object>
      if (sid.length === 0 || !proj) {
        continue
      }
      const seq = Number(proj['asOfSeq'] ?? 0)
      const raw = proj['values'] as Record<string, Object>
      if (!raw) {
        continue
      }
      const values: Record<string, Object> = {}
      for (const k of Object.keys(raw)) {
        values[k] = raw[k]
      }
      put(sid, seq, values)
    }
  }

  /** 顶层会话（非子代理） */
  isTopLevel(): boolean {
    return this.parentSessionId.length === 0 && this.origin !== 'subagent'
  }

  /**
   * 会话列表用于展示的标题。
   * 与 WebUI titleOf 对齐：未命名会话统一显示「新会话」，不用工作区名兜底。
   */
  displayTitle(): string {
    const t = this.title.trim()
    if (t.length > 0) {
      return t
    }
    return this.sessionId.length > 0 ? I18n.t('新会话', 'New session') : I18n.t('未知会话', 'Unknown')
  }

  /**
   * 列表标签：未命名会话在标题后附带短标识（sessionId 末 8 位），
   * 与 WebUI sessionLabelOf 一致，便于区分多个未命名会话。
   */
  displayLabel(): string {
    const title = this.displayTitle()
    if (this.sessionId.length === 0 || this.title.trim().length > 0) {
      return title
    }
    return title + ' · ' + this.shortId()
  }

  /** sessionId 末 8 位短标识 */
  shortId(): string {
    return this.sessionId.length > 8 ? this.sessionId.substring(this.sessionId.length - 8) : this.sessionId
  }

  /** cwd 末段（工作区名） */
  workspaceName(): string {
    const raw = this.cwd.trim()
    if (raw.length === 0) {
      return ''
    }
    const clean = raw.replace(/[\\/]+$/, '')
    const parts = clean.split(/[\\/]/)
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].length > 0) {
        return parts[i]
      }
    }
    return clean
  }

  /** 副标题：工作区完整路径 */
  workspaceLabel(): string {
    const raw = this.cwd.trim()
    return raw.length > 0 ? raw : I18n.t('未指定工作区', 'No workspace')
  }

  /** 运行状态 */
  statusLabel(): string {
    if (this.running) {
      return I18n.t('运行中', 'Running')
    }
    return this.blank ? I18n.t('空白会话', 'Blank') : I18n.t('空闲', 'Idle')
  }

  /** 相对时间：刚刚 / N 分钟前 / HH:mm / 昨天 HH:mm / MM-DD / YYYY-MM-DD */
  updatedLabel(): string {
    const t = this.updatedAt
    if (t <= 0) {
      return ''
    }
    const d = new Date(t)
    const now = new Date()
    const pad = (n: number): string => n < 10 ? '0' + n : String(n)
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
    const diff = now.getTime() - t
    if (diff >= 0 && diff < 60000) {
      return I18n.t('刚刚', 'now')
    }
    if (diff >= 0 && diff < 3600000) {
      return Math.floor(diff / 60000).toString() + I18n.t(' 分钟前', 'm ago')
    }
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    if (sameDay) {
      return hm
    }
    const y = new Date(now.getTime() - 86400000)
    const isYesterday = d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() &&
      d.getDate() === y.getDate()
    if (isYesterday) {
      return I18n.t('昨天 ', 'Yesterday ') + hm
    }
    if (d.getFullYear() === now.getFullYear()) {
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    }
    return d.getFullYear().toString() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  }
}
