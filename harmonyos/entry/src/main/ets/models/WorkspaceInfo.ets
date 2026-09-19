/**
 * 工作区条目（workspace.list 响应项的展示子集）。
 *
 * 契约（与 public/app.js 的 refreshWorkbench 对齐）：
 *   RPC result.value = { items: [ { workspaceId, path, title? } ],
 *                        archivedSessionIds?: string[] }
 * 名称取 title，缺省回退 path 末段（与 WebUI workspaceName 一致）。
 */
export class WorkspaceInfo {
  workspaceId: string = ''
  path: string = ''
  title: string = ''

  static fromRecord(r: Record<string, Object>): WorkspaceInfo {
    const w = new WorkspaceInfo()
    w.workspaceId = String(r['workspaceId'] ?? '')
    w.path = String(r['path'] ?? '')
    w.title = String(r['title'] ?? '')
    return w
  }

  static fromRpcValue(v: Object): WorkspaceInfo[] {
    const list: WorkspaceInfo[] = []
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
      const w = WorkspaceInfo.fromRecord(item)
      if (w.workspaceId.length > 0) {
        list.push(w)
      }
    }
    return list
  }

  /** 显示名：title → path 末段 → path */
  displayName(): string {
    const t = this.title.trim()
    if (t.length > 0) {
      return t
    }
    const clean = this.path.replace(/[\\/]+$/, '')
    const parts = clean.split(/[\\/]/)
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].length > 0) {
        return parts[i]
      }
    }
    return clean
  }
}
