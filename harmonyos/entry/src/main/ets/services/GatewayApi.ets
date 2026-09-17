import { http } from '@kit.NetworkKit'
import { Constants } from '../common/Constants'
import { HealthInfo } from '../models/HealthInfo'

export interface RespondResult {
  ok: boolean
  value: Object
}

/**
 * 网关 HTTP 客户端：health、DSH RPC、事件轮询、统计。
 * 契约见 docs/modules/01-contracts.md。
 */
export class GatewayApi {
  private static normalized(base: string): string {
    return base.replace(/\/+$/, '')
  }

  private static newRpcId(): string {
    return 'r-' + Date.now().toString() + '-' + Math.floor(Math.random() * 1000000).toString()
  }

  /** GET /health */
  static async getHealth(base: string, timeoutMs: number = 8000): Promise<HealthInfo> {
    const data = await GatewayApi.getJson(base, '/health?t=' + Date.now().toString(), null, timeoutMs)
    return HealthInfo.fromRecord(data)
  }

  /**
   * GET /diagnostics：需要 Bearer token 的轻量端点。
   * /health 是免鉴权的，只有它无法区分"网关活着"和"令牌正确"，
   * 因此连接测试必须再打一次带鉴权的端点。
   */
  static async diagnosticsOk(base: string, token: string, timeoutMs: number = 8000): Promise<boolean> {
    await GatewayApi.getJson(base, '/diagnostics?t=' + Date.now().toString(), token, timeoutMs)
    return true
  }

  /** 测速：health 往返毫秒，失败返回 -1 */
  static async latencyMs(base: string): Promise<number> {
    const start = Date.now()
    try {
      await GatewayApi.getHealth(base, 8000)
      return Date.now() - start
    } catch (e) {
      return -1
    }
  }

  /** POST /api/{method}：DSH RPC（client-request） */
  static async rpc(base: string, token: string, method: string, payload: Object,
    timeoutMs: number = Constants.RPC_TIMEOUT_MS): Promise<Object> {
    const req = http.createHttp()
    try {
      const body = JSON.stringify({
        type: 'client-request',
        rpcId: GatewayApi.newRpcId(),
        method: method,
        payload: payload
      })
      const header: Record<string, string> = {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + token,
        'x-dsh-remote-client': 'app'
      }
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.POST,
        header: header,
        extraData: body,
        connectTimeout: 8000,
        readTimeout: timeoutMs,
        expectDataType: http.HttpDataType.STRING
      }
      const resp = await req.request(GatewayApi.normalized(base) + '/api/' + method, options)
      if (resp.responseCode === 401) {
        throw new Error('AUTH')
      }
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error('HTTP ' + resp.responseCode.toString())
      }
      const text = resp.result as string
      const full = JSON.parse(text) as Record<string, Object>
      const result = full['result'] as Record<string, Object>
      if (!result || result['ok'] !== true) {
        const err = result ? result['error'] as Record<string, Object> : null
        const msg = err ? String(err['message'] ?? 'DSH RPC error') : 'empty result'
        throw new Error(msg)
      }
      return result['value'] as Object
    } finally {
      req.destroy()
    }
  }

  /** POST /api/respond：审批/提问应答（client-response） */
  static async respond(base: string, token: string, rpcId: string, value: Object): Promise<boolean> {
    const req = http.createHttp()
    try {
      const result: RespondResult = { ok: true, value: value }
      const body = JSON.stringify({
        type: 'client-response',
        rpcId: rpcId,
        result: result
      })
      const header: Record<string, string> = {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + token,
        'x-dsh-remote-client': 'app'
      }
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.POST,
        header: header,
        extraData: body,
        connectTimeout: 8000,
        readTimeout: 15000,
        expectDataType: http.HttpDataType.STRING
      }
      const resp = await req.request(GatewayApi.normalized(base) + '/api/respond', options)
      if (resp.responseCode === 401) {
        throw new Error('AUTH')
      }
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        return false
      }
      const text = resp.result as string
      const receipt = JSON.parse(text) as Record<string, Object>
      return receipt['accepted'] === true
    } finally {
      req.destroy()
    }
  }

  /** GET {base}/update.json：更新信息（公开，无需鉴权） */
  static async fetchUpdateInfo(base: string): Promise<Record<string, Object>> {
    return await GatewayApi.getJson(base, '/update.json?t=' + Date.now().toString(), null, 8000)
  }

  /** GET /fs/list：目录列表 */
  static async fsList(base: string, token: string, path: string): Promise<Record<string, Object>> {
    const q = path && path.length > 0 ? '?path=' + encodeURIComponent(path) : ''
    return await GatewayApi.getJson(base, '/fs/list' + q, token, 15000)
  }

  /** GET /fs/preview：文本预览 */
  static async fsPreview(base: string, token: string, path: string): Promise<Record<string, Object>> {
    const q = '?path=' + encodeURIComponent(path)
    return await GatewayApi.getJson(base, '/fs/preview' + q, token, 15000)
  }

  /** GET /fs/file：下载文件内容（ArrayBuffer） */
  static async fsDownload(base: string, token: string, path: string): Promise<ArrayBuffer> {
    const req = http.createHttp()
    try {
      const header: Record<string, string> = {
        'authorization': 'Bearer ' + token,
        'x-dsh-remote-client': 'app'
      }
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.GET,
        header: header,
        connectTimeout: 8000,
        readTimeout: 60000,
        expectDataType: http.HttpDataType.ARRAY_BUFFER
      }
      const resp = await req.request(GatewayApi.normalized(base) + '/fs/file?path=' + encodeURIComponent(path), options)
      if (resp.responseCode === 401) {
        throw new Error('AUTH')
      }
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error('HTTP ' + resp.responseCode.toString())
      }
      return resp.result as ArrayBuffer
    } finally {
      req.destroy()
    }
  }

  /**
   * POST /fs/mkdir?path=<parent>&name=<dir>：新建子目录。
   * 对应 WebUI createWorkspace 的 mkdir 一步（网关 gateway.js serveFs）。
   * 失败抛出网关返回的 error 文案（exists / bad-name）。
   */
  static async fsMkdir(base: string, token: string, parent: string, name: string): Promise<string> {
    const req = http.createHttp()
    try {
      const q = '?path=' + encodeURIComponent(parent) + '&name=' + encodeURIComponent(name)
      const header: Record<string, string> = {
        'authorization': 'Bearer ' + token,
        'x-dsh-remote-client': 'app'
      }
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.POST,
        header: header,
        connectTimeout: 8000,
        readTimeout: 15000,
        expectDataType: http.HttpDataType.STRING
      }
      const resp = await req.request(GatewayApi.normalized(base) + '/fs/mkdir' + q, options)
      if (resp.responseCode === 401) {
        throw new Error('AUTH')
      }
      const text = resp.result as string
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        let msg = 'HTTP ' + resp.responseCode.toString()
        try {
          const data = JSON.parse(text) as Record<string, Object>
          msg = String(data['error'] ?? msg)
        } catch (ignore) {
          // 保留 HTTP 状态码文案
        }
        throw new Error(msg)
      }
      const data = JSON.parse(text) as Record<string, Object>
      return String(data['path'] ?? '')
    } finally {
      req.destroy()
    }
  }

  /**
   * GET /api/session.export?sessionId=..&includeDescendants=true：会话日志 ZIP。
   * 与 WebUI sessionLogExportUrl 一致（含子代理会话）。
   */
  static async sessionExport(base: string, token: string, sessionId: string): Promise<ArrayBuffer> {
    const req = http.createHttp()
    try {
      const q = '?sessionId=' + encodeURIComponent(sessionId) + '&includeDescendants=true'
      const header: Record<string, string> = {
        'authorization': 'Bearer ' + token,
        'x-dsh-remote-client': 'app'
      }
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.GET,
        header: header,
        connectTimeout: 8000,
        readTimeout: 125000,
        expectDataType: http.HttpDataType.ARRAY_BUFFER
      }
      const resp = await req.request(GatewayApi.normalized(base) + '/api/session.export' + q, options)
      if (resp.responseCode === 401) {
        throw new Error('AUTH')
      }
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error('HTTP ' + resp.responseCode.toString())
      }
      return resp.result as ArrayBuffer
    } finally {
      req.destroy()
    }
  }

  /** GET {base}/announcements.json：公告列表（公开，无鉴权） */
  static async fetchAnnouncementsRaw(base: string): Promise<Object> {
    const req = http.createHttp()
    try {
      const header: Record<string, string> = { 'x-dsh-remote-client': 'app' }
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.GET,
        header: header,
        connectTimeout: 8000,
        readTimeout: 8000,
        expectDataType: http.HttpDataType.STRING
      }
      const resp = await req.request(GatewayApi.normalized(base) + '/announcements.json?t=' + Date.now().toString(), options)
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error('HTTP ' + resp.responseCode.toString())
      }
      const text = resp.result as string
      return JSON.parse(text) as Object
    } finally {
      req.destroy()
    }
  }

  /** POST /feedback：公告投票提交 */
  static async postFeedback(base: string, token: string, payload: Record<string, Object>): Promise<boolean> {
    const req = http.createHttp()
    try {
      const header: Record<string, string> = {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + token,
        'x-dsh-remote-client': 'app'
      }
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.POST,
        header: header,
        extraData: JSON.stringify(payload),
        connectTimeout: 8000,
        readTimeout: 8000,
        expectDataType: http.HttpDataType.STRING
      }
      const resp = await req.request(GatewayApi.normalized(base) + '/feedback', options)
      if (resp.responseCode === 401) {
        throw new Error('AUTH')
      }
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error('HTTP ' + resp.responseCode.toString())
      }
      const data = JSON.parse(resp.result as string) as Record<string, Object>
      return data['ok'] === true
    } finally {
      req.destroy()
    }
  }

  /** POST /remote/api/command：斜杠命令桥（网关 → 插件命令服务） */
  static async slashCommand(base: string, token: string, sessionId: string, line: string,
    timeoutMs: number = 20000): Promise<Object> {
    const req = http.createHttp()
    try {
      const header: Record<string, string> = {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + token,
        'x-dsh-remote-client': 'app'
      }
      const payload: Record<string, string> = { 'sessionId': sessionId, 'line': line }
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.POST,
        header: header,
        extraData: JSON.stringify(payload),
        connectTimeout: 8000,
        readTimeout: timeoutMs,
        expectDataType: http.HttpDataType.STRING
      }
      const resp = await req.request(GatewayApi.normalized(base) + '/remote/api/command', options)
      if (resp.responseCode === 401) {
        throw new Error('AUTH')
      }
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error('HTTP ' + resp.responseCode.toString())
      }
      const text = resp.result as string
      return JSON.parse(text) as Record<string, Object>
    } finally {
      req.destroy()
    }
  }

  /** GET /api/events.poll：增量轮询 */
  static async pollEvents(base: string, token: string, kind: string, since: number):
    Promise<Record<string, Object>> {
    const path = `/api/events.poll?kind=${kind}&since=${since.toString()}&wait=25000`
    return await GatewayApi.getJson(base, path, token, 30000)
  }

  /** GET /stats/summary */
  static async statsSummary(base: string, token: string, days: number): Promise<Record<string, Object>> {
    const path = `/stats/summary?days=${days.toString()}`
    return await GatewayApi.getJson(base, path, token, 15000)
  }

  /** 通用 GET JSON（/fs/*、/health 等） */
  static async getJson(base: string, path: string, token: string | null, timeoutMs: number):
    Promise<Record<string, Object>> {
    const req = http.createHttp()
    try {
      const header: Record<string, string> = { 'x-dsh-remote-client': 'app' }
      if (token && token.length > 0) {
        header['authorization'] = 'Bearer ' + token
      }
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.GET,
        header: header,
        connectTimeout: 8000,
        readTimeout: timeoutMs,
        expectDataType: http.HttpDataType.STRING
      }
      const resp = await req.request(GatewayApi.normalized(base) + path, options)
      if (resp.responseCode === 401) {
        throw new Error('AUTH')
      }
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error('HTTP ' + resp.responseCode.toString())
      }
      const text = resp.result as string
      return JSON.parse(text) as Record<string, Object>
    } finally {
      req.destroy()
    }
  }
}