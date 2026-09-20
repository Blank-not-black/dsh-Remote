/**
 * 服务器连接条目（对应 Web 端 servers-v2 中的一条记录）。
 * 连接身份为 url + token；同一地址允许配置多个不同 token。
 */
export class ServerInfo {
  id: string
  url: string
  note: string
  group: string
  token: string

  constructor(id: string, url: string, note: string, group: string, token: string) {
    this.id = id
    this.url = url
    this.note = note
    this.group = group
    this.token = token
  }

  /** 归一化去尾斜杠的地址 */
  normalizedUrl(): string {
    return this.url.replace(/\/+$/, '')
  }

  static fromRecord(r: Record<string, Object>): ServerInfo {
    const id: string = r['id'] as string ?? ''
    const url: string = r['url'] as string ?? ''
    const note: string = r['note'] as string ?? ''
    const group: string = r['group'] as string ?? '默认'
    const token: string = r['token'] as string ?? ''
    return new ServerInfo(id, url, note, group, token)
  }

  toRecord(): Record<string, Object> {
    const rec: Record<string, Object> = {}
    rec['id'] = this.id
    rec['url'] = this.url
    rec['note'] = this.note
    rec['group'] = this.group
    rec['token'] = this.token
    return rec
  }

  static fromJsonArray(json: string): ServerInfo[] {
    const list: ServerInfo[] = []
    if (!json) {
      return list
    }
    try {
      const arr = JSON.parse(json) as Array<Record<string, Object>>
      for (const item of arr) {
        list.push(ServerInfo.fromRecord(item))
      }
    } catch (e) {
      // 解析失败返回空列表
    }
    return list
  }

  static toJsonArray(list: ServerInfo[]): string {
    const records: Array<Record<string, Object>> = []
    for (const s of list) {
      records.push(s.toRecord())
    }
    return JSON.stringify(records)
  }
}