/**
 * 跨端接续指针（对应网关 /handoff 的单条记录）。
 * 一台设备离开会话时写入，另一台设备进会话列表时读取，
 * 展示"在 xx 上打开过"卡片，点击直接跳到该会话。
 * 只传指针不传内容：消息仍走 DSH 实时通道。
 */
export class HandoffState {
  sessionId: string = ''
  title: string = ''
  /** 写入方设备名（deviceInfo.marketName，如 "HUAWEI Mate 60 Pro"） */
  device: string = ''
  /** 写入方客户端 id（StorageService.getOrCreateClientId；接收方用它排除自己写的） */
  clientId: string = ''
  /** 写入时间（毫秒 epoch；网关侧 7 天过期） */
  at: number = 0

  static fromRecord(r: Record<string, Object> | null): HandoffState | null {
    if (!r) {
      return null
    }
    const sid = r['sessionId'] as string ?? ''
    if (sid.length === 0) {
      return null
    }
    const h = new HandoffState()
    h.sessionId = sid
    h.title = r['title'] as string ?? ''
    h.device = r['device'] as string ?? ''
    h.clientId = r['clientId'] as string ?? ''
    const atRaw = r['at']
    h.at = typeof atRaw === 'number' ? atRaw : Number(atRaw ?? 0)
    return h
  }

  toRecord(): Record<string, Object> {
    const rec: Record<string, Object> = {}
    rec['sessionId'] = this.sessionId
    rec['title'] = this.title
    rec['device'] = this.device
    rec['clientId'] = this.clientId
    rec['at'] = Date.now()
    return rec
  }
}
