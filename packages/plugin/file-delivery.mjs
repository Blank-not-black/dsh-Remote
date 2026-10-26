// DSH model-facing file delivery tools. Host services are optional; no SDK dependency.
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const description = 'Send a single existing local file to a paired DSH Remote device. The recipient must explicitly accept before downloading. A queued delivery is NOT a successful receipt. Use remote_devices first and remote_file_status to check results. Do not repeatedly send after an uncertain response.'
const objectSchema = properties => ({ type: 'object', additionalProperties: false, properties })
const string = description => ({ type: 'string', description })
const output = {
  schema: { ...objectSchema({ ok: { type: 'boolean' }, message: { type: 'string' }, details: { type: 'string' } }), required: ['ok', 'message', 'details'] },
  render: (_args, value) => [{ type: 'text', text: value.message + '\n' + value.details }],
}
const result = (value, message) => ({ ok: true, message, details: JSON.stringify(value) })
export function createDeliveryTools(ctx, request) {
  const context = exec => {
    const sessionId = exec?.agent?.session?.id
    if (!sessionId || !exec.callId) throw new Error('Remote 文件工具需要有效的 DSH 会话与工具调用编号')
    exec.signal?.throwIfAborted()
    return sessionId
  }
  const definition = (name, description, properties, required, execute) => ({ name, description, parameters: { ...objectSchema(properties), required }, output, execute, timeoutMs: 60000 })
  return [
    definition('remote_devices', 'List paired Remote receiving devices, including offline devices. Ask the user which device to use if ambiguous. Devices appear after opening the Remote file inbox.', {}, [], async (args, exec) => {
      context(exec)
      if (!args || Object.keys(args).length) throw new Error('remote_devices 不接受参数')
      return result(await request('GET', null, exec.signal), '选择明确的接收设备；离线设备可以暂存文件，24 小时内打开 Remote 接收。')
    }),
    definition('remote_send_file', description, { path: string('Existing local regular file inside the calling session working directory, at most 50 MiB.'), device_id: string('Exact receiver id returned by remote_devices.'), title: string('Short title for the recipient.'), message: string('Optional explanation for the recipient, at most 600 characters.') }, ['path', 'device_id'], async (args, exec) => {
      const sessionId = context(exec)
      if (!args || Object.keys(args).some(k => !['path', 'device_id', 'title', 'message'].includes(k)) || typeof args.path !== 'string' || !args.path.trim() || typeof args.device_id !== 'string' || !args.device_id || args.title !== undefined && (typeof args.title !== 'string' || args.title.length > 120) || args.message !== undefined && (typeof args.message !== 'string' || args.message.length > 600)) throw new Error('文件、设备编号或说明参数无效')
      // Resolve in the session's execution world first. Remote v1 additionally
      // requires a host-local path under the current working directory.
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const target = await ctx.fs.resolve(args.path, { cwd, signal: exec.signal })
      const info = await ctx.fs.stat(target, exec.signal)
      if (!info || info.type !== 'file' || info.size > 50 * 1024 * 1024) throw new Error('仅支持不超过 50 MiB 的本地普通文件')
      const local = ctx.fs.processPath(target)
      if (!isAbsolute(local) || !isAbsolute(cwd)) throw new Error('第一版仅支持主机本地工作目录中的文件')
      const workspaceRoot = realpathSync(cwd), source = realpathSync(local), rel = relative(workspaceRoot, source)
      if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('文件必须位于当前会话工作目录内，不能通过链接越界')
      exec.signal?.throwIfAborted()
      const id = createHash('sha256').update(sessionId + '\0' + exec.callId).digest('hex')
      try {
        const receipt = await request('POST', { action: 'send', id, path: resolve(source), workspaceRoot, deviceId: args.device_id, sessionId, title: args.title || '', message: args.message || '' }, exec.signal)
        return result(receipt, '文件已投递待确认，尚未接收。使用 remote_file_status 查询；不要报告已保存。')
      } catch (error) {
        if (error.confirmed) throw error
        throw new Error('投递结果未确认，请勿重复发送。使用 remote_file_status 查询编号：' + id)
      }
    }),
    definition('remote_file_status', 'Check a delivery from this session. pending/accepted/downloading are not success; downloaded means handed to a browser, complete means the device reported saving it.', { transfer_id: string('Transfer id from remote_send_file, including an uncertain send error.') }, ['transfer_id'], async (args, exec) => {
      const sessionId = context(exec)
      if (!args || Object.keys(args).some(k => k !== 'transfer_id') || typeof args.transfer_id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(args.transfer_id)) throw new Error('传输编号无效')
      return result(await request('POST', { action: 'status', id: args.transfer_id, sessionId }, exec.signal), '状态以接收设备回执为准；downloaded 只表示交给浏览器保存，不能证明文件已落盘。')
    }),
  ]
}

export function registerFileDeliveryTools(ctx, { gatewayBase, gatewayToken, fetchImpl = fetch }) {
  if (typeof ctx.inject !== 'function') return false
  ctx.inject(['tools', 'fs', 'workingDirectory'], child => {
    const service = name => child.get?.(name) ?? child[name]
    const scoped = { fs: service('fs'), workingDirectory: service('workingDirectory') }
    const tools = service('tools')
    if (!tools?.register || !scoped.fs?.resolve || !scoped.workingDirectory?.ensure) return
    const request = async (method, body, signal) => {
      const token = gatewayToken()
      if (!token) throw Object.assign(new Error('Remote 网关尚未就绪，请先启动网关'), { confirmed: true })
      const timeout = AbortSignal.timeout(55000)
      const combined = new AbortController()
      const abort = () => combined.abort()
      signal?.addEventListener('abort', abort, { once: true }); timeout.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      try {
        const response = await fetchImpl(gatewayBase() + '/admin/api/file-inbox', { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: combined.signal, redirect: 'error' })
        const data = await response.json()
        if (!response.ok) throw Object.assign(new Error('Remote 文件投递被拒绝：' + String(data.error || response.status).slice(0, 100)), { confirmed: response.status < 500 })
        return data
      } finally { signal?.removeEventListener('abort', abort); timeout.removeEventListener('abort', abort) }
    }
    for (const definition of createDeliveryTools(scoped, request)) child.effect(() => tools.register(definition), 'dsh-remote: ' + definition.name)
  })
  return true
}
