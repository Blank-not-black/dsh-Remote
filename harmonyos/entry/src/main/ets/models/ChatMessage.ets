/**
 * 会话消息显示模型。
 * 从 history/实时事件解析出可渲染的用户/助手消息与运行状态行。
 *
 * 真实事件形态（session.history 的 events[].event）：
 *   user/message      → data = { role:'user', content:[{type:'text'|'image'}] }
 *   assistant/message → data = { turn, step, message:{ role, content:[blocks] } }
 *                       blocks 类型：reasoning / text / tool-call
 *   agent/status      → data = { running }
 * 工具调用与思考过程单独存放，避免正文被噪声淹没。
 */
export class ChatMessage {
  seq: number
  type: string
  role: string
  text: string
  images: string[]
  running: boolean
  /** 思考过程（reasoning 块） */
  reasoning: string
  /** 工具调用名（tool-call 块，按出现顺序） */
  tools: string[]
  /**
   * 压缩摘要标记：DSH /compact 后以 user/message 注入的 checkpoint 消息，
   * 摘要正文存本字段（去掉 <compacted-summary> 包裹），text 置空。
   * UI 默认折叠为一行摘要条，点击展开。
   */
  compaction: string

  constructor(seq: number, type: string, role: string, text: string, images: string[],
    running: boolean, reasoning: string, tools: string[], compaction: string = '') {
    this.seq = seq
    this.type = type
    this.role = role
    this.text = text
    this.images = images
    this.running = running
    this.reasoning = reasoning
    this.tools = tools
    this.compaction = compaction
  }

  /**
   * history 条目 / 实时事件 → 显示消息。
   * 无可显示内容的事件返回 null（system/message、step/*、tool/result 等）。
   */
  static fromEvent(ev: Record<string, Object>): ChatMessage | null {
    if (!ev) {
      return null
    }
    const type = String(ev['type'] ?? '')
    const seq = Number(ev['seq'] ?? 0)
    if (type === 'user/message') {
      return ChatMessage.fromUser(seq, ev)
    }
    if (type === 'assistant/message') {
      return ChatMessage.fromAssistant(seq, ev)
    }
    if (type === 'tool/call' || type === 'tool/result') {
      return ChatMessage.fromToolEvent(seq, type, ev)
    }
    if (type === 'agent/status') {
      const data = ev['data'] as Record<string, Object> ?? {}
      const running = data['running'] as boolean ?? false
      return new ChatMessage(seq, type, 'system', running ? '任务开始' : '任务结束', [],
        running, '', [])
    }
    return null
  }

  /**
   * 独立工具事件（tool/call / tool/result）→ 左对齐白底小气泡。
   * call 显示「运行中」，result 显示「完成」；结果文本作为折叠预览（最多 6 行）。
   * 同一 callId 的 call+result 会各显示一条（与 WebUI 的工具卡片一致）。
   */
  private static fromToolEvent(seq: number, type: string, ev: Record<string, Object>): ChatMessage | null {
    const data = ev['data'] as Record<string, Object> ?? {}
    const name = String(data['name'] ?? '')
    const callId = String(data['callId'] ?? '')
    let preview = ''
    if (type === 'tool/result') {
      const msg = data['message'] as Record<string, Object> ?? {}
      const blocks = msg['content'] as Array<Record<string, Object>> ?? []
      for (const b of blocks) {
        const bt = String(b['type'] ?? '')
        if (bt === 'tool-result') {
          const inner = b['content'] as Array<Record<string, Object>> ?? []
          for (const t of inner) {
            const tt = String(t['type'] ?? '')
            if (tt === 'text') {
              preview = String(t['text'] ?? '')
              break
            }
          }
        } else if (bt === 'text' && preview.length === 0) {
          preview = String(b['text'] ?? '')
        }
        if (preview.length > 0) {
          break
        }
      }
    }
    const label = name.length > 0 ? name : (callId.length > 0 ? callId : 'tool')
    const status = type === 'tool/call' ? '运行中…' : '完成'
    const text = `工具 ${label} · ${status}` + (preview.length > 0 ? '\n' + ChatMessage.previewOf(preview) : '')
    return new ChatMessage(seq, type, 'tool', text, [], false, '', [])
  }

  /** 结果预览截断：最多 6 行、每行 120 字符 */
  private static previewOf(text: string): string {
    const lines = text.replace(/\t/g, '  ').split('\n')
    const out: string[] = []
    let count = 0
    for (const l of lines) {
      if (count >= 6) {
        out.push('…')
        break
      }
      out.push(l.length > 120 ? l.substring(0, 120) + '…' : l)
      count++
    }
    return out.join('\n')
  }

  private static fromUser(seq: number, ev: Record<string, Object>): ChatMessage | null {
    const data = ev['data'] as Record<string, Object> ?? {}
    const role = String(data['role'] ?? 'user')
    const blocks = data['content'] as Array<Record<string, Object>> ?? []
    let text: string = ''
    const images: string[] = []
    for (const b of blocks) {
      const bt = String(b['type'] ?? '')
      if (bt === 'text') {
        const t = String(b['text'] ?? '')
        if (t.length > 0) {
          text = text.length > 0 ? text + '\n' + t : text + t
        }
      } else if (bt === 'image') {
        const d = String(b['data'] ?? '')
        if (d.length > 0) {
          images.push(d)
        }
      }
    }
    // DSH /compact 的 checkpoint 注入消息：<compacted-summary> 包裹的压缩摘要。
    // 默认对用户是噪声，识别后转为折叠摘要条（正文放 compaction，text 置空）。
    if (text.includes('<compacted-summary>')) {
      const summary = ChatMessage.extractCompaction(text)
      if (summary !== null) {
        return new ChatMessage(seq, 'user/message', 'compaction', '', images, false, '', [], summary)
      }
    }
    if (text.length === 0 && images.length === 0) {
      return null
    }
    return new ChatMessage(seq, 'user/message', role, text, images, false, '', [])
  }

  /** 提取 <compacted-summary>…</compacted-summary> 之间的摘要正文；缺失返回 null */
  private static extractCompaction(text: string): string | null {
    const start = text.indexOf('<compacted-summary>')
    if (start < 0) {
      return null
    }
    const body = text.substring(start + '<compacted-summary>'.length)
    const end = body.lastIndexOf('</compacted-summary>')
    const content = (end >= 0 ? body.substring(0, end) : body).trim()
    return content.length > 0 ? content : null
  }

  private static fromAssistant(seq: number, ev: Record<string, Object>): ChatMessage | null {
    const data = ev['data'] as Record<string, Object> ?? {}
    const msg = data['message'] as Record<string, Object> ?? {}
    const role = String(msg['role'] ?? 'assistant')
    const blocks = msg['content'] as Array<Record<string, Object>> ??
      data['content'] as Array<Record<string, Object>> ?? []
    let text: string = ''
    let reasoning: string = ''
    const images: string[] = []
    const tools: string[] = []
    for (const b of blocks) {
      const bt = String(b['type'] ?? '')
      if (bt === 'text') {
        const t = String(b['text'] ?? '')
        if (t.length > 0) {
          text = text.length > 0 ? text + '\n' + t : text + t
        }
      } else if (bt === 'reasoning') {
        const t = String(b['text'] ?? '')
        if (t.length > 0) {
          reasoning = reasoning.length > 0 ? reasoning + '\n' + t : reasoning + t
        }
      } else if (bt === 'tool-call' || bt === 'tool_call') {
        const name = String(b['name'] ?? b['toolName'] ?? 'tool')
        tools.push(name)
      } else if (bt === 'image') {
        const d = String(b['data'] ?? '')
        if (d.length > 0) {
          images.push(d)
        }
      }
    }
    if (text.length === 0 && reasoning.length === 0 && images.length === 0 && tools.length === 0) {
      return null
    }
    // 超长正文截断（如 /compact 摘要、大段粘贴）：
    // 无上限的 Text 会把 ListItem 撑到极高，List 滚动直接卡死。
    return new ChatMessage(seq, 'assistant/message', role, ChatMessage.truncate(text), images, false,
      ChatMessage.truncate(reasoning), tools)
  }

  /** 正文截断：最多 300 行，超出的行丢弃并附提示 */
  private static truncate(text: string): string {
    if (text.length === 0) {
      return text
    }
    const lines = text.split('\n')
    if (lines.length <= 300 && text.length <= 30000) {
      return text
    }
    const kept = lines.slice(0, 300)
    return kept.join('\n') + `\n…（内容过长，已截断 ${lines.length - 300} 行；完整内容请在电脑端查看）`
  }

  /** 工具调用的紧凑展示：bash ×2 · read_file */
  toolsLabel(): string {
    if (this.tools.length === 0) {
      return ''
    }
    const names: string[] = []
    const counts: number[] = []
    for (const t of this.tools) {
      let found = -1
      for (let i = 0; i < names.length; i++) {
        if (names[i] === t) {
          found = i
          break
        }
      }
      if (found >= 0) {
        counts[found] = counts[found] + 1
      } else {
        names.push(t)
        counts.push(1)
      }
    }
    const parts: string[] = []
    for (let i = 0; i < names.length; i++) {
      parts.push(counts[i] > 1 ? names[i] + ' ×' + counts[i].toString() : names[i])
    }
    return parts.join(' · ')
  }
}
