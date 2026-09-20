/**
 * 网关 /health 响应模型。
 * 网关活着不等于实时就绪：实时可用还需看 events.mux / events.host。
 */
export class HealthInfo {
  ok: boolean = false
  version: string = ''
  pid: number = 0
  upstream: string = ''
  upstreamOk: boolean = false
  upstreamReachable: boolean = false
  upstreamStatus: number = 0
  eventsMux: boolean = false
  eventsHost: boolean = false
  /** readiness.eventsOk：mux 与 host 双通道都连通 */
  eventsOk: boolean = false
  runtime: number = 0

  static fromRecord(r: Record<string, Object>): HealthInfo {
    const h = new HealthInfo()
    h.ok = r['ok'] as boolean ?? false
    h.version = r['version'] as string ?? ''
    h.pid = r['pid'] as number ?? 0
    h.upstream = r['upstream'] as string ?? ''
    h.upstreamOk = r['upstreamOk'] as boolean ?? false
    h.upstreamReachable = r['upstreamReachable'] as boolean ?? false
    h.upstreamStatus = r['upstreamStatus'] as number ?? 0
    // events.mux / events.host 是对象（{connected, lastEventAt, reconnects, ...}），
    // 旧版网关可能直接给布尔值，两种形态都兼容。
    const events = r['events'] as Record<string, Object>
    if (events) {
      h.eventsMux = HealthInfo.channelConnected(events['mux'])
      h.eventsHost = HealthInfo.channelConnected(events['host'])
    }
    const readiness = r['readiness'] as Record<string, Object>
    if (readiness) {
      h.eventsOk = readiness['eventsOk'] as boolean ?? false
    } else {
      h.eventsOk = h.eventsMux && h.eventsHost
    }
    h.runtime = r['runtime'] as number ?? 0
    return h
  }

  private static channelConnected(v: Object): boolean {
    if (v === null || v === undefined) {
      return false
    }
    if (typeof v === 'boolean') {
      return v as boolean
    }
    const rec = v as Record<string, Object>
    return rec['connected'] as boolean ?? false
  }
}