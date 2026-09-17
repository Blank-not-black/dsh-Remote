import { webSocket } from '@kit.NetworkKit'
import { BusinessError } from '@kit.BasicServicesKit'
import { Constants } from '../common/Constants'
import { Logger } from '../common/Logger'
import { GatewayApi } from './GatewayApi'

/**
 * 事件帧回调：kind 为 mux/host，frame 为 JSON 字符串。
 */
export type FrameHandler = (kind: string, frame: string) => void
export type ModeHandler = (mode: string) => void

/**
 * 实时链路：mux/host 双 WebSocket（downlink-only），
 * 任一通道连续失败达到阈值后降级为 /api/events.poll 轮询，
 * 轮询模式每 30s 尝试恢复 WS。对齐 Web 端行为与 docs/modules/01-contracts.md。
 */
export class RealtimeService {
  private static instance: RealtimeService | null = null

  static getInstance(): RealtimeService {
    if (RealtimeService.instance === null) {
      RealtimeService.instance = new RealtimeService()
    }
    return RealtimeService.instance
  }

  private handler: FrameHandler | null = null
  private modeHandler: ModeHandler | null = null
  private base: string = ''
  private token: string = ''
  private clientId: string = ''
  private sockets: Map<string, webSocket.WebSocket> = new Map()
  private failures: Map<string, number> = new Map()
  private attempts: Map<string, number> = new Map()
  private retryTimers: Map<string, number> = new Map()
  private pollSeq: Map<string, number> = new Map()
  private pollTimer: number = -1
  private restoreTimer: number = -1
  private generation: number = 0
  private mode: string = 'idle'
  /** 当前真正握手成功的通道；用于避免"没连上也显示已连接" */
  private openedKinds: Set<string> = new Set()

  getMode(): string {
    return this.mode
  }

  start(base: string, token: string, clientId: string, handler: FrameHandler,
    modeHandler: ModeHandler | null): void {
    this.stop()
    this.base = base
    this.token = token
    this.clientId = clientId
    this.handler = handler
    this.modeHandler = modeHandler
    this.generation++
    this.failures.set('mux', 0)
    this.failures.set('host', 0)
    this.attempts.set('mux', 0)
    this.attempts.set('host', 0)
    this.pollSeq.set('mux', 0)
    this.pollSeq.set('host', 0)
    this.setMode('connecting')
    this.openStream('mux')
    this.openStream('host')
  }

  stop(): void {
    this.generation++
    this.handler = null
    this.modeHandler = null
    this.openedKinds.clear()
    this.clearPollTimers()
    for (const kind of ['mux', 'host']) {
      this.clearRetry(kind)
      this.closeSocket(kind)
    }
    this.base = ''
    this.token = ''
    this.clientId = ''
    this.setMode('idle')
  }

  private setMode(m: string): void {
    if (this.mode === m) {
      return
    }
    this.mode = m
    if (this.modeHandler) {
      this.modeHandler(m)
    }
  }

  private isCurrent(kind: string, gen: number): boolean {
    return gen === this.generation && this.base.length > 0 && this.token.length > 0
  }

  private closeSocket(kind: string): void {
    if (this.sockets.has(kind)) {
      const ws = this.sockets.get(kind) as webSocket.WebSocket
      this.sockets.delete(kind)
      try {
        ws.close({ code: 1000, reason: 'close' }, () => {
          Logger.info('ws closed ' + kind)
        })
      } catch (e) {
        Logger.warn('ws close error ' + kind)
      }
    }
  }

  private openStream(kind: string): void {
    if (this.mode === 'poll' || this.base.length === 0 || this.token.length === 0) {
      return
    }
    const wsBase = this.base.replace(/^http/, 'ws')
    const url = `${wsBase}/api/events.${kind}?token=${encodeURIComponent(this.token)}` +
      `&client=${Constants.WS_CLIENT_MARK}&clientId=${encodeURIComponent(this.clientId)}`
    this.closeSocket(kind)
    const ws = webSocket.createWebSocket()
    this.sockets.set(kind, ws)
    const gen = this.generation

    ws.on('open', (err: BusinessError) => {
      if (!this.isCurrent(kind, gen)) {
        return
      }
      this.failures.set(kind, 0)
      this.attempts.set(kind, 0)
      this.clearRetry(kind)
      this.openedKinds.add(kind)
      this.setMode('ws')
      Logger.info('stream open ' + kind)
    })

    ws.on('message', (err: BusinessError, value: string | ArrayBuffer) => {
      if (!this.isCurrent(kind, gen)) {
        return
      }
      const frame = typeof value === 'string' ? value : ''
      if (frame.length > 0 && this.handler) {
        this.handler(kind, frame)
      }
    })

    ws.on('close', (err: BusinessError, value: webSocket.CloseResult) => {
      if (!this.isCurrent(kind, gen)) {
        return
      }
      this.sockets.delete(kind)
      this.openedKinds.delete(kind)
      Logger.warn('stream close ' + kind + ' code=' + value.code.toString())
      this.downgradeIfNoChannel()
      this.handleClose(kind, gen)
    })

    ws.on('error', (err: BusinessError) => {
      const detail = err ? err.message : 'unknown'
      Logger.warn('stream error ' + kind + ' ' + detail)
      this.openedKinds.delete(kind)
      this.downgradeIfNoChannel()
      this.closeSocket(kind)
    })

    ws.connect(url, (err: BusinessError, ok: boolean) => {
      if (err) {
        const detail = err.message ? err.message : 'unknown'
        Logger.warn('stream connect error ' + kind + ' ' + detail)
        this.sockets.delete(kind)
        this.openedKinds.delete(kind)
        this.downgradeIfNoChannel()
        this.handleClose(kind, gen)
      }
    })
  }

  /** 两条通道都不在线时，不能继续对外声称"实时已连接" */
  private downgradeIfNoChannel(): void {
    if (this.mode === 'ws' && this.openedKinds.size === 0) {
      Logger.warn('all streams down, back to connecting')
      this.setMode('connecting')
    }
  }

  private handleClose(kind: string, gen: number): void {
    if (!this.isCurrent(kind, gen) || this.mode === 'poll') {
      return
    }
    const f = (this.failures.get(kind) ?? 0) + 1
    this.failures.set(kind, f)
    if (f >= Constants.POLL_FAILURE_THRESHOLD) {
      this.enterPollMode()
      return
    }
    const attempt = this.attempts.get(kind) ?? 0
    this.attempts.set(kind, attempt + 1)
    const baseDelay = Math.min(1500 * Math.pow(2, attempt), 60000)
    const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.4))
    this.clearRetry(kind)
    const timer = setTimeout(() => {
      if (this.mode !== 'poll' && this.base.length > 0 && this.token.length > 0) {
        this.openStream(kind)
      }
    }, delay)
    this.retryTimers.set(kind, timer)
  }

  private clearRetry(kind: string): void {
    if (this.retryTimers.has(kind)) {
      const timer = this.retryTimers.get(kind) as number
      clearTimeout(timer)
      this.retryTimers.delete(kind)
    }
  }

  private clearPollTimers(): void {
    if (this.pollTimer >= 0) {
      clearInterval(this.pollTimer)
      this.pollTimer = -1
    }
    if (this.restoreTimer >= 0) {
      clearInterval(this.restoreTimer)
      this.restoreTimer = -1
    }
  }

  private enterPollMode(): void {
    if (this.mode === 'poll') {
      return
    }
    Logger.warn('enter poll mode')
    this.setMode('poll')
    this.closeSocket('mux')
    this.closeSocket('host')
    this.pollSeq.set('mux', 0)
    this.pollSeq.set('host', 0)
    this.clearPollTimers()
    this.pollTimer = setInterval(() => {
      this.pollOnce()
    }, Constants.POLL_INTERVAL_MS)
    this.restoreTimer = setInterval(() => {
      this.tryRestoreWs()
    }, Constants.WS_RESTORE_INTERVAL_MS)
    this.pollOnce()
  }

  private async pollOnce(): Promise<void> {
    await this.pollKind('mux')
    await this.pollKind('host')
  }

  private async pollKind(kind: string): Promise<void> {
    if (this.mode !== 'poll' || this.base.length === 0 || this.token.length === 0) {
      return
    }
    const since = this.pollSeq.get(kind) ?? 0
    let data: Record<string, Object> | null = null
    try {
      data = await GatewayApi.pollEvents(this.base, this.token, kind, since)
    } catch (e) {
      return
    }
    if (this.mode !== 'poll') {
      return
    }
    const events = data['events'] as Array<Record<string, Object>>
    if (!events) {
      return
    }
    const reset = data['truncated'] as boolean ?? false
    const latestSeq = data['latestSeq'] as number ?? 0
    if (reset || (latestSeq > 0 && latestSeq < since)) {
      this.pollSeq.set(kind, 0)
    }
    const cur = this.pollSeq.get(kind) ?? 0
    for (const item of events) {
      const seq = item['seq'] as number ?? 0
      if (seq <= cur) {
        continue
      }
      this.pollSeq.set(kind, seq)
      const eventObj = item['event'] as Object
      if (eventObj && this.handler) {
        const frame = typeof eventObj === 'string' ? eventObj : JSON.stringify(eventObj)
        this.handler(kind, frame)
      }
    }
  }

  private tryRestoreWs(): void {
    if (this.mode !== 'poll' || this.base.length === 0 || this.token.length === 0) {
      return
    }
    Logger.info('try restore ws')
    this.setMode('ws')
    this.failures.set('mux', 0)
    this.failures.set('host', 0)
    this.openStream('mux')
    this.openStream('host')
  }
}