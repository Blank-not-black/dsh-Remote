/* B6 组合输入增强：当前会话命令、权限内 @ 引用、消息选段引用。
 *
 * 零依赖、零网络：命令与引用目录、以及“能不能引用”的权限判断都在主机
 * 适配器里完成；本模块只负责触发识别、候选渲染、键盘/触控选择、草稿内
 * 精确插入和待发送引用管理。旧主机没有目录接口时静默降级——/命令 与
 * 纯文本仍可手输发送，@ 文本原样保留，不伪造主机语义。
 *
 * 浏览器用法：root.DshComposerTools.create({ input, menu, hint, quoteList, host })
 * Node 测试：module.exports 暴露 create 与纯函数。
 */
'use strict'
;(function (root) {
  const MAX_COMMANDS = 40
  const MAX_REFERENCES = 30
  const MAX_QUOTES = 8
  const MAX_QUOTE_CHARS = 4000
  const COMMAND_CACHE_MS = 15000
  const COMMAND_NAME = /^[^\s/]{1,64}$/
  const REFERENCE_TOKEN = /^@[^\r\n]{1,511}$/
  // 触发边界：@ 只能出现在行首或空白/常见开括号之后，避免把邮箱当引用。
  const REFERENCE_BOUNDARY = /[\s([{<'"`]/
  let instanceSeq = 0

  const asText = value => typeof value === 'string' ? value : ''
  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
  }

  /* 返回 null 表示主机明确未提供该目录（降级）；空数组表示“已支持但为空”。 */
  function listFrom(payload, keys) {
    if (payload == null) return null
    if (Array.isArray(payload)) return payload
    if (!isPlainObject(payload)) return null
    if (payload.supported === false || payload.available === false) return null
    for (const key of keys) if (Array.isArray(payload[key])) return payload[key]
    return payload.supported === true ? [] : null
  }

  function normalizeCommandRow(row) {
    if (!isPlainObject(row)) return null
    let name = asText(row.name || row.command || row.id).trim()
    if (name.startsWith('/')) name = name.replace(/^\/+/, '')
    if (!COMMAND_NAME.test(name)) return null
    const aliases = []
    if (Array.isArray(row.aliases)) {
      for (const alias of row.aliases) {
        const value = asText(alias).trim().replace(/^\/+/, '')
        if (COMMAND_NAME.test(value) && !aliases.includes(value)) aliases.push(value)
      }
    }
    const description = asText(row.description || row.summary).trim().slice(0, 200)
    const source = asText(row.source || row.plugin).trim().slice(0, 60)
    const argumentHint = asText(row.argumentHint || row.usageHint || row.args).trim().slice(0, 80)
    return { name, aliases, description, source, argumentHint }
  }

  /* 主机目录可能带 /，也可能直接是数组；去重、限长，权限字段只做保守过滤。 */
  function normalizeCommandRows(payload) {
    const list = listFrom(payload, ['commands', 'items'])
    if (list == null) return null
    const rows = [], seen = new Set()
    for (const raw of list) {
      const row = normalizeCommandRow(raw)
      if (!row) continue
      const key = row.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(row)
      if (rows.length >= MAX_COMMANDS) break
    }
    return rows
  }

  function normalizeReferenceRow(row) {
    if (!isPlainObject(row)) return null
    // 权限由主机执行：显式拒绝项绝不进入候选，也不在客户端猜测权限。
    if (row.allowed === false || row.denied === true || row.permitted === false) return null
    const insert = asText(row.insert || row.token).trim()
    if (!REFERENCE_TOKEN.test(insert)) return null
    const label = asText(row.label || row.name || row.title).trim().slice(0, 120) || insert
    const detail = asText(row.detail || row.description || row.subtitle).trim().slice(0, 160)
    const kind = asText(row.kind || row.type).trim().slice(0, 24)
    return { insert, label, detail, kind }
  }

  function normalizeReferenceRows(payload) {
    const list = listFrom(payload, ['references', 'items'])
    if (list == null) return null
    const rows = [], seen = new Set()
    for (const raw of list) {
      const row = normalizeReferenceRow(raw)
      if (!row) continue
      if (seen.has(row.insert)) continue
      seen.add(row.insert)
      rows.push(row)
      if (rows.length >= MAX_REFERENCES) break
    }
    return rows
  }

  const lower = value => asText(value).toLowerCase()

  /* 命令前缀优先，其次包含匹配；空查询返回全部（主机目录顺序即优先级）。 */
  function filterCommandRows(rows, query) {
    const q = lower(query).trim()
    const list = Array.isArray(rows) ? rows : []
    if (!q) return list.slice()
    const prefix = [], contains = []
    for (const row of list) {
      if (!row) continue
      const names = [row.name, ...(Array.isArray(row.aliases) ? row.aliases : [])].map(lower)
      if (names.some(name => name.startsWith(q))) prefix.push(row)
      else if (names.some(name => name.includes(q))) contains.push(row)
    }
    return prefix.concat(contains)
  }

  function filterReferenceRows(rows, query) {
    const q = lower(query).trim()
    const list = Array.isArray(rows) ? rows : []
    if (!q) return list.slice()
    const matched = list.filter(row => row && (lower(row.label).includes(q) || lower(row.insert).includes(q) || lower(row.detail).includes(q)))
    // 保持主机返回顺序，稳定的“无匹配”体验由调用方决定。
    return matched
  }

  function caretOf(input) {
    const value = String(input && input.value != null ? input.value : '')
    const start = input && Number.isInteger(input.selectionStart) ? input.selectionStart : value.length
    return Math.max(0, Math.min(start, value.length))
  }

  function tokenEnd(value, caret) {
    let end = caret
    while (end < value.length && !/[\s/]/.test(value[end])) end += 1
    return end
  }

  function referenceStart(value, caret) {
    let at = value.lastIndexOf('@', caret - 1)
    while (at >= 0) {
      if (at === 0 || REFERENCE_BOUNDARY.test(value[at - 1])) return at
      at = value.lastIndexOf('@', at - 1)
    }
    return -1
  }

  /* 纯函数：根据草稿与光标识别命令/引用触发；无触发返回 null。
   * start..end 是接受候选时要替换的 token 区间（含结尾未输入完的部分）。 */
  function detectTrigger(value, caret) {
    const text = asText(value)
    const pos = Math.max(0, Math.min(Number.isInteger(caret) ? caret : text.length, text.length))
    const before = text.slice(0, pos)
    const command = /^(\/+)([^\s/]*)$/.exec(before)
    if (command) {
      // 命令必须从文档开头起算；end 覆盖当前 token 的剩余部分。
      let end = command[1].length + command[2].length
      while (end < text.length && !/[\s/]/.test(text[end])) end += 1
      return { kind: 'command', query: command[2], start: 0, end, slashes: command[1] }
    }
    const at = referenceStart(text, pos)
    if (at < 0) return null
    const query = text.slice(at + 1, pos)
    // 引用 token 内出现空白说明用户已结束该引用；此时关闭菜单，@ 保持普通文本。
    if (/\s/.test(query)) return null
    return { kind: 'reference', query, start: at, end: tokenEnd(text, pos) }
  }

  function fileReferenceMention(candidate) {
    const path = asText(candidate?.path)
    if (!path || /[\x00-\x1f\x7f-\x9f"]/.test(path)) return ''
    const value = candidate.kind === 'directory' && !path.endsWith('/') ? path + '/' : path
    return /\s/.test(value) ? '@"' + value + '"' : '@' + value
  }

  function sameTrigger(a, b) {
    return !!a && !!b && a.kind === b.kind && a.start === b.start && a.end === b.end && a.query === b.query
  }

  function insertAt(value, start, end, insert) {
    const text = asText(value)
    const from = Math.max(0, Math.min(Number.isInteger(start) ? start : 0, text.length))
    const to = Math.max(from, Math.min(Number.isInteger(end) ? end : from, text.length))
    const addition = asText(insert)
    return { value: text.slice(0, from) + addition + text.slice(to), caret: from + addition.length }
  }

  /* 选段规格：主机的 messageId/seq 与角色原样保留，正文只做去控制字符与限长。 */
  function sanitizeQuote(raw) {
    if (!isPlainObject(raw)) return null
    const source = asText(raw.text != null ? raw.text : raw.quote).replace(/\r\n?/g, '\n')
    const text = source.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    if (!text.trim()) return null
    const clipped = text.slice(0, MAX_QUOTE_CHARS)
    const rawId = raw.messageId != null ? raw.messageId : raw.seq
    const messageId = rawId == null ? '' : String(rawId).trim().slice(0, 200)
    const role = asText(raw.role).trim().toLowerCase().slice(0, 20)
    return {
      messageId,
      role: /^[a-z-]{1,20}$/.test(role) ? role : '',
      text: clipped,
      truncated: text.length > MAX_QUOTE_CHARS,
    }
  }

  function quotePreview(text, max = 90) {
    const line = asText(text).split('\n').find(value => value.trim()) || ''
    const flat = line.replace(/\s+/g, ' ').trim()
    if (flat.length <= max) return flat
    return flat.slice(0, Math.max(1, max - 1)) + '…'
  }

  /* 主机原生语义：消息引用按 Markdown 块引用输出，不添加客户端自造的署名/标签。 */
  function formatQuotes(quotes) {
    const list = Array.isArray(quotes) ? quotes : []
    return list.map(quote => {
      const text = asText(quote && quote.text).replace(/\r\n?/g, '\n')
      if (!text) return ''
      return text.split('\n').map(line => '> ' + line).join('\n')
    }).filter(Boolean).join('\n\n')
  }

  function create(options) {
    options = options || {}
    const doc = options.document || root.document
    if (!doc || typeof doc.createElement !== 'function') throw new TypeError('composer tools: document is required')
    const input = options.input
    if (!input) throw new TypeError('composer tools: input is required')
    const host = options.host || {}
    const commandsEnabled = options.commands !== false
    const menu = options.menu || null
    const hint = options.hint || null
    const quoteList = options.quoteList || null
    const instance = ++instanceSeq
    const menuId = 'ct-menu-' + instance

    const state = {
      destroyed: false,
      scopeKey: '',
      quotesByScope: new Map(),
      quotes: [],
      quoteSeq: 0,
      expanded: new Set(),
      generation: 0,
      pending: null,
      hinted: new Set(),
      commandCache: { key: null, at: 0, rows: null },
      capabilities: { commands: 'unknown', references: 'unknown' },
      menu: { open: false, kind: '', items: [], nodes: [], active: -1, trigger: null, scopeKey: '' },
      hintText: '',
    }

    const english = () => (options.i18n || (root.I18N && root.I18N.lang) || 'zh') === 'en'
    const L = (zh, en) => english() ? en : zh

    function node(tag, className, text) {
      const element = doc.createElement(tag)
      if (className) element.className = className
      if (text != null) element.textContent = text
      return element
    }

    function scopeOf(value) {
      if (typeof value === 'string') return value
      if (!isPlainObject(value)) return ''
      const key = value.key != null ? value.key : (value.sessionId != null ? value.sessionId : value.id)
      return key == null ? '' : String(key)
    }

    function currentScope() {
      let scope = null
      try { scope = typeof host.scope === 'function' ? host.scope() : null } catch { scope = null }
      if (typeof scope === 'string') return { key: scope }
      return isPlainObject(scope) ? scope : { key: '' }
    }

    function currentKey() {
      return scopeOf(currentScope())
    }

    function connectionValid(scope) {
      const connection = scope && scope.connection
      return !connection || typeof connection.valid !== 'function' || connection.valid() !== false
    }

    function live(captured) {
      return !state.destroyed && captured.gen === state.generation &&
        captured.key === currentKey() && connectionValid(currentScope())
    }

    function showHint(text, kind) {
      if (!hint || !text) return
      const value = String(text)
      if (state.hintText === value && hint.hidden === false) return
      state.hintText = value
      hint.textContent = value
      hint.hidden = false
      if (hint.classList) {
        hint.classList.toggle('ct-hint-error', kind === 'error')
        hint.classList.remove('hidden')
      }
    }

    function clearHint() {
      state.hintText = ''
      if (!hint) return
      hint.textContent = ''
      hint.hidden = true
      if (hint.classList) hint.classList.add('hidden')
    }

    function hintOnce(key, zh, en) {
      const id = state.scopeKey + '\u0000' + key
      if (state.hinted.has(id)) return
      state.hinted.add(id)
      showHint(L(zh, en), 'info')
    }

    function notify(text, kind) {
      try { host.notice?.(text, kind) } catch {}
    }

    function setInputAria(open) {
      if (!input.setAttribute) return
      if (open) {
        input.setAttribute('aria-expanded', 'true')
        input.setAttribute('aria-controls', menuId)
      } else if (input.getAttribute?.('aria-controls') === menuId) {
        input.setAttribute('aria-expanded', 'false')
        input.removeAttribute?.('aria-controls')
        input.removeAttribute?.('aria-activedescendant')
      }
    }

    function closeMenu() {
      const wasOpen = state.menu.open
      // 关闭候选即作废所有在途目录请求，避免迟到结果把已关闭的菜单重新打开。
      state.generation += 1
      state.menu = { open: false, kind: '', items: [], nodes: [], active: -1, trigger: null, scopeKey: '' }
      state.pending = null
      if (menu) {
        menu.hidden = true
        if (menu.classList) { menu.classList.add('hidden') }
        if (menu.replaceChildren) menu.replaceChildren()
      }
      setInputAria(false)
      return wasOpen
    }

    function setActive(index) {
      const count = state.menu.items.length
      if (!state.menu.open || !count) return -1
      const active = ((Number(index) % count) + count) % count
      state.menu.active = active
      state.menu.nodes.forEach((element, i) => {
        const selected = i === active
        if (element.classList) element.classList.toggle('is-active', selected)
        element.setAttribute?.('aria-selected', selected ? 'true' : 'false')
      })
      const activeNode = state.menu.nodes[active]
      if (input.setAttribute && activeNode && activeNode.id) input.setAttribute('aria-activedescendant', activeNode.id)
      try { activeNode?.scrollIntoView?.({ block: 'nearest' }) } catch {}
      return active
    }

    function move(delta) {
      return setActive(state.menu.active + delta)
    }

    function commandItem(row) {
      return {
        kind: 'command',
        key: 'cmd:' + row.name.toLowerCase(),
        name: row.name,
        label: '/' + row.name,
        detail: row.description,
        meta: row.argumentHint || row.source,
      }
    }

    function referenceItem(row) {
      return {
        kind: 'reference',
        key: 'ref:' + row.insert,
        insert: row.insert,
        label: row.label,
        detail: row.detail,
        meta: row.kind || row.insert,
      }
    }

    function openMenu(kind, trigger, items) {
      if (!items.length) { closeMenu(); return }
      if (!menu) return
      closeMenu()
      menu.hidden = false
      if (menu.classList) { menu.classList.remove('hidden'); menu.classList.add('ct-menu') }
      if (!menu.id) menu.id = menuId
      menu.setAttribute?.('role', 'listbox')
      menu.setAttribute?.('aria-label', kind === 'command' ? L('会话命令', 'Session commands') : L('可引用内容', 'Referenceable items'))
      const nodes = items.map((item, index) => {
        const button = node('button', 'ct-item ct-' + item.kind)
        button.type = 'button'
        button.id = menuId + '-item-' + index
        button.setAttribute('role', 'option')
        button.setAttribute('aria-selected', 'false')
        button.dataset.ctIndex = String(index)
        const main = node('span', 'ct-item-main')
        main.append(node('span', 'ct-item-name', item.label))
        if (item.detail) main.append(node('span', 'ct-item-detail', item.detail))
        if (item.meta && item.meta !== item.label) main.append(node('span', 'ct-item-meta', item.meta))
        button.append(main)
        // 触控：按下时不抢焦点，随后 click 再接受；移动端不必先悬停。
        if (button.addEventListener) {
          button.addEventListener('mousedown', event => { try { event.preventDefault() } catch {} })
          button.addEventListener('click', event => {
            try { event.preventDefault() } catch {}
            accept(index)
          })
        }
        menu.append(button)
        return button
      })
      state.menu = { open: true, kind, items: items.slice(), nodes, active: -1, trigger, scopeKey: currentKey() }
      state.pending = null
      setInputAria(true)
      const active = Number.isInteger(options.activeIndex) && options.activeIndex >= 0 ? options.activeIndex : 0
      setActive(active)
    }

    function showCommands(rows, trigger) {
      const filtered = filterCommandRows(rows, trigger.query)
      if (!filtered.length) { closeMenu(); return }
      clearHint()
      openMenu('command', trigger, filtered.map(commandItem))
    }

    function showReferences(rows, trigger) {
      const filtered = filterReferenceRows(rows, trigger.query)
      if (!filtered.length) {
        closeMenu()
        return
      }
      clearHint()
      openMenu('reference', trigger, filtered.map(referenceItem))
    }

    function commandRowsFor(trigger, generation) {
      const scope = currentScope()
      const key = currentKey()
      if (state.capabilities.commands === 'unsupported') {
        closeMenu()
        hintOnce('commands-unsupported', '当前主机没有命令目录，可手输 /命令 或纯文本发送。', 'This host has no command catalog. Type the /command or plain text and send it.')
        return
      }
      if (!connectionValid(scope)) { closeMenu(); return }
      if (state.commandCache.key === key && state.commandCache.rows && Date.now() - state.commandCache.at < COMMAND_CACHE_MS) {
        showCommands(state.commandCache.rows, trigger)
        return
      }
      if (typeof host.listCommands !== 'function') {
        state.capabilities.commands = 'unsupported'
        closeMenu()
        hintOnce('commands-unsupported', '当前主机没有命令目录，可手输 /命令 或纯文本发送。', 'This host has no command catalog. Type the /command or plain text and send it.')
        return
      }
      const captured = { gen: generation, key }
      showHint(L('正在读取当前会话的命令…', 'Loading this session’s commands…'), 'info')
      Promise.resolve()
        .then(() => host.listCommands(scope))
        .then(payload => {
          if (!live(captured)) return
          state.pending = null
          const rows = normalizeCommandRows(payload)
          if (rows == null) {
            state.capabilities.commands = 'unsupported'
            closeMenu()
            hintOnce('commands-unsupported', '当前主机没有命令目录，可手输 /命令 或纯文本发送。', 'This host has no command catalog. Type the /command or plain text and send it.')
            return
          }
          state.capabilities.commands = 'supported'
          state.commandCache = { key, at: Date.now(), rows }
          showCommands(rows, trigger)
        })
        .catch(() => {
          if (!live(captured)) return
          state.pending = null
          closeMenu()
          hintOnce('commands-error', '暂时无法读取命令目录，仍可手输 /命令 后发送。', 'The command catalog is unavailable right now; you can still type and send the /command.')
        })
    }

    function referenceRowsFor(trigger, generation) {
      const scope = currentScope()
      const key = currentKey()
      if (state.capabilities.references === 'unsupported') {
        closeMenu()
        hintOnce('references-unsupported', '当前主机不支持 @ 引用，@ 会作为普通文本发送。', 'This host has no @ references; the @ text will be sent as plain text.')
        return
      }
      if (!connectionValid(scope)) { closeMenu(); return }
      if (typeof host.listReferences !== 'function') {
        state.capabilities.references = 'unsupported'
        closeMenu()
        hintOnce('references-unsupported', '当前主机不支持 @ 引用，@ 会作为普通文本发送。', 'This host has no @ references; the @ text will be sent as plain text.')
        return
      }
      const captured = { gen: generation, key }
      showHint(L('正在读取可引用内容…', 'Loading referenceable items…'), 'info')
      Promise.resolve()
        .then(() => host.listReferences(scope, trigger.query))
        .then(payload => {
          if (!live(captured)) return
          state.pending = null
          const rows = normalizeReferenceRows(payload)
          if (rows == null) {
            state.capabilities.references = 'unsupported'
            closeMenu()
            hintOnce('references-unsupported', '当前主机不支持 @ 引用，@ 会作为普通文本发送。', 'This host has no @ references; the @ text will be sent as plain text.')
            return
          }
          state.capabilities.references = 'supported'
          showReferences(rows, trigger)
        })
        .catch(() => {
          if (!live(captured)) return
          state.pending = null
          closeMenu()
          hintOnce('references-error', '暂时无法读取可引用内容，@ 将作为普通文本发送。', 'Referenceable items are unavailable right now; the @ text will be sent as plain text.')
        })
    }

    function sync() {
      if (state.destroyed) return
      const value = String(input.value != null ? input.value : '')
      const trigger = detectTrigger(value, caretOf(input))
      const key = currentKey()
      if (!trigger || (trigger.kind === 'command' && !commandsEnabled)) { closeMenu(); return }
      // 键位移动/重复事件不重开菜单，否则方向键会把高亮重置回第一项。
      if (state.menu.open && state.menu.scopeKey === key && sameTrigger(state.menu.trigger, trigger)) return
      if (state.pending && state.pending.key === key && sameTrigger(state.pending.trigger, trigger)) return
      const generation = ++state.generation
      state.pending = { gen: generation, key, trigger }
      if (trigger.kind === 'command') commandRowsFor(trigger, generation)
      else referenceRowsFor(trigger, generation)
    }

    function writeValue(value, caret) {
      input.value = value
      if (typeof input.setSelectionRange === 'function') input.setSelectionRange(caret, caret)
      if (typeof input.focus === 'function') input.focus()
      try { input.dispatchEvent?.(new root.Event('input', { bubbles: true })) } catch {}
    }

    /* 把触发的 token 换成主机原生文本；已有空白分隔时跳过它，避免接受后
     * 光标仍停在 token 内导致候选立刻重开。 */
    function replaceTrigger(value, trigger, insert) {
      const nextChar = value[trigger.end]
      const pad = nextChar == null || !/\s/.test(nextChar) ? ' ' : ''
      const result = insertAt(value, trigger.start, trigger.end, insert + pad)
      if (!pad) result.caret += 1
      return result
    }

    function accept(index) {
      if (state.destroyed || !state.menu.open) return false
      const position = Number.isInteger(index) ? index : state.menu.active
      const item = state.menu.items[position]
      if (!item) return false
      const value = String(input.value != null ? input.value : '')
      const trigger = detectTrigger(value, caretOf(input))
      if (!trigger || trigger.kind !== item.kind) { closeMenu(); return false }
      const insert = item.kind === 'command' ? '/' + item.name : item.insert
      const result = replaceTrigger(value, trigger, insert)
      closeMenu()
      writeValue(result.value, result.caret)
      options.onChange?.({
        kind: item.kind,
        item: item.kind === 'command'
          ? { name: item.name, label: item.label }
          : { insert: item.insert, label: item.label },
        value: result.value,
        caret: result.caret,
      })
      return true
    }

    function keydown(event) {
      if (state.destroyed || !event || event.defaultPrevented) return false
      // 输入法组合期间不拦截按键，避免吞掉中文候选确认。
      if (event.isComposing || event.key === 'Process') return false
      if (!state.menu.open) return false
      const key = event.key
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        try { event.preventDefault() } catch {}
        move(key === 'ArrowDown' ? 1 : -1)
        return true
      }
      if (key === 'Enter' || key === 'Tab') {
        if (!state.menu.items.length) return false
        const accepted = accept()
        if (accepted) { try { event.preventDefault() } catch {} }
        return accepted
      }
      if (key === 'Escape') {
        try { event.preventDefault() } catch {}
        closeMenu()
        return true
      }
      return false
    }

    /* 供旧静态 chip/触控面板调用：草稿内插入，绝不整框覆盖。 */
    function insertCommand(name) {
      if (state.destroyed) return false
      const clean = asText(name).trim().replace(/^\/+/, '')
      if (!COMMAND_NAME.test(clean)) return false
      const value = String(input.value != null ? input.value : '')
      const trigger = detectTrigger(value, caretOf(input))
      if (trigger && trigger.kind === 'command') {
        const item = { name: clean, label: '/' + clean }
        const result = replaceTrigger(value, trigger, '/' + clean)
        closeMenu()
        writeValue(result.value, result.caret)
        options.onChange?.({ kind: 'command', item, value: result.value, caret: result.caret })
        return true
      }
      // 命令必须位于整条草稿开头才会被主机当作斜杠命令；原文保留为后续参数，
      // 不整框覆盖用户未发送的草稿。
      const result = insertAt(value, 0, 0, '/' + clean + ' ')
      closeMenu()
      writeValue(result.value, result.caret)
      options.onChange?.({ kind: 'command', item: { name: clean, label: '/' + clean }, value: result.value, caret: result.caret })
      return true
    }

    function insertReference(token) {
      const clean = asText(token).trim()
      if (state.destroyed || !REFERENCE_TOKEN.test(clean)) return false
      const value = String(input.value != null ? input.value : '')
      const trigger = detectTrigger(value, caretOf(input))
      if (trigger && trigger.kind === 'reference') {
        const result = replaceTrigger(value, trigger, clean)
        closeMenu()
        writeValue(result.value, result.caret)
        options.onChange?.({ kind: 'reference', item: { insert: clean, label: clean }, value: result.value, caret: result.caret })
        return true
      }
      const start = caretOf(input)
      const end = Math.max(start, Number.isInteger(input.selectionEnd) ? input.selectionEnd : start)
      // 保留 @ 的主机原生词边界：前面紧贴字符时补一个空格。
      const prefix = start > 0 && !/\s/.test(value[start - 1]) ? ' ' : ''
      const result = insertAt(value, start, end, prefix + clean + ' ')
      closeMenu()
      writeValue(result.value, result.caret)
      options.onChange?.({ kind: 'reference', item: { insert: clean, label: clean }, value: result.value, caret: result.caret })
      return true
    }

    function roleLabel(role) {
      if (role === 'user') return L('你的消息', 'Your message')
      if (role === 'assistant') return L('助手消息', 'Assistant message')
      return L('消息', 'Message')
    }

    function quoteView(quote) {
      return {
        id: quote.id,
        messageId: quote.messageId,
        role: quote.role,
        text: quote.text,
        truncated: quote.truncated,
        preview: quote.preview,
      }
    }

    function renderQuotes() {
      if (!quoteList) return
      if (typeof quoteList.replaceChildren !== 'function') return
      quoteList.replaceChildren()
      if (!state.quotes.length) {
        quoteList.hidden = true
        if (quoteList.classList) quoteList.classList.add('hidden')
        return
      }
      quoteList.hidden = false
      if (quoteList.classList) quoteList.classList.remove('hidden')
      for (const quote of state.quotes) {
        const expanded = state.expanded.has(quote.id)
        const card = node('div', 'ct-quote')
        card.dataset.quoteId = quote.id
        card.setAttribute?.('data-quote-id', quote.id)
        const head = node('div', 'ct-quote-head')
        const meta = node('span', 'ct-quote-meta', L('引用', 'Quote') + ' · ' + roleLabel(quote.role) +
          (quote.messageId ? ' · #' + quote.messageId.slice(0, 40) : ''))
        meta.title = quote.messageId ? L('来源消息：', 'Source message: ') + quote.messageId : ''
        const inspect = node('button', 'ct-quote-inspect', expanded ? L('收起', 'Collapse') : L('展开', 'Expand'))
        inspect.type = 'button'
        inspect.setAttribute?.('aria-expanded', expanded ? 'true' : 'false')
        inspect.addEventListener?.('click', () => toggleQuote(quote.id))
        const remove = node('button', 'ct-quote-remove', L('移除', 'Remove'))
        remove.type = 'button'
        remove.setAttribute?.('aria-label', L('移除引用', 'Remove quote'))
        remove.addEventListener?.('click', () => removeQuote(quote.id))
        head.append(meta, inspect, remove)
        const preview = node('p', 'ct-quote-preview', quote.preview)
        const full = node('pre', 'ct-quote-full', quote.text)
        full.hidden = !expanded
        if (quote.truncated) full.append(node('span', 'ct-quote-truncated', L('（已截断，仅引用前 4000 字符）', ' (truncated to the first 4,000 characters)')))
        card.append(head, preview, full)
        quoteList.append(card)
      }
    }

    function quotesChanged() {
      options.onQuotesChange?.(quotes())
    }

    function addQuote(raw) {
      if (state.destroyed) return null
      const sanitized = sanitizeQuote(raw)
      if (!sanitized) return null
      const key = sanitized.messageId + '\u0000' + sanitized.text
      const existing = state.quotes.find(quote => quote.key === key)
      if (existing) return quoteView(existing)
      if (state.quotes.length >= MAX_QUOTES) {
        notify(L('最多同时引用 8 条消息，请先移除部分引用。', 'You can quote up to 8 messages; remove one first.'), 'err')
        return null
      }
      const quote = {
        ...sanitized,
        key,
        id: 'ctq-' + instance + '-' + (++state.quoteSeq),
        preview: quotePreview(sanitized.text),
      }
      state.quotes.push(quote)
      renderQuotes()
      quotesChanged()
      return quoteView(quote)
    }

    function removeQuote(id) {
      const index = state.quotes.findIndex(quote => quote.id === id)
      if (index < 0) return false
      state.quotes.splice(index, 1)
      state.expanded.delete(id)
      renderQuotes()
      quotesChanged()
      return true
    }

    function toggleQuote(id) {
      const quote = state.quotes.find(item => item.id === id)
      if (!quote) return false
      if (state.expanded.has(id)) state.expanded.delete(id)
      else state.expanded.add(id)
      renderQuotes()
      return true
    }

    function quotes() {
      return state.quotes.map(quoteView)
    }

    function clearQuotes(ids) {
      const remaining = ids ? state.quotes.filter(quote => !ids.includes(quote.id)) : []
      if (remaining.length === state.quotes.length) return
      state.quotes = remaining
      if (ids) for (const id of ids) state.expanded.delete(id)
      else state.expanded.clear()
      renderQuotes()
      quotesChanged()
    }

    function setScope(next) {
      const key = scopeOf(next)
      if (key === state.scopeKey) return
      state.quotesByScope.set(state.scopeKey, state.quotes)
      state.scopeKey = key
      // 引用跟着所在会话的草稿走，切换会话绝不把引用带进另一条消息。
      state.quotes = (state.quotesByScope.get(key) || []).slice()
      state.expanded.clear()
      state.generation += 1
      state.hinted.clear()
      state.commandCache = { key: null, at: 0, rows: null }
      state.capabilities = { commands: 'unknown', references: 'unknown' }
      closeMenu()
      clearHint()
      renderQuotes()
    }

    function status() {
      return {
        scope: state.scopeKey,
        commands: state.capabilities.commands,
        references: state.capabilities.references,
        menuOpen: state.menu.open,
        menuKind: state.menu.kind,
        quotes: state.quotes.length,
      }
    }

    function menuSnapshot() {
      return {
        open: state.menu.open,
        kind: state.menu.kind,
        query: state.menu.trigger ? state.menu.trigger.query : '',
        active: state.menu.active,
        items: state.menu.items.map(item => ({ kind: item.kind, label: item.label, name: item.name, insert: item.insert })),
      }
    }

    function containsNode(container, target) {
      for (let nodeValue = target; nodeValue; nodeValue = nodeValue.parentElement) {
        if (nodeValue === container) return true
      }
      return false
    }

    function onDocumentPointerDown(event) {
      const target = event && event.target
      if (!target) return
      if (containsNode(input, target) || (menu && containsNode(menu, target))) return
      closeMenu()
    }

    const listeners = {
      input: () => sync(),
      keydown: event => keydown(event),
      keyup: event => {
        if (!event || !event.key) { sync(); return }
        if (/^(Arrow|Home|End|Page)/.test(event.key)) sync()
      },
      click: () => sync(),
      pointerdown: event => onDocumentPointerDown(event),
    }
    input.addEventListener?.('input', listeners.input)
    input.addEventListener?.('keydown', listeners.keydown)
    input.addEventListener?.('keyup', listeners.keyup)
    input.addEventListener?.('click', listeners.click)
    doc.addEventListener?.('pointerdown', listeners.pointerdown, true)

    state.scopeKey = currentKey()
    renderQuotes()
    closeMenu()

    function destroy() {
      if (state.destroyed) return
      state.destroyed = true
      state.generation += 1
      closeMenu()
      input.removeEventListener?.('input', listeners.input)
      input.removeEventListener?.('keydown', listeners.keydown)
      input.removeEventListener?.('keyup', listeners.keyup)
      input.removeEventListener?.('click', listeners.click)
      doc.removeEventListener?.('pointerdown', listeners.pointerdown, true)
      if (hint) { hint.hidden = true }
      if (quoteList && quoteList.replaceChildren) quoteList.replaceChildren()
    }

    return {
      sync, keydown, accept, move, close: closeMenu,
      addQuote, removeQuote, toggleQuote, quotes, clearQuotes,
      insertCommand, insertReference, setScope, destroy, status, menuSnapshot,
      formatQuotes: () => formatQuotes(state.quotes),
    }
  }

  const api = {
    create,
    detectTrigger,
    fileReferenceMention,
    insertAt,
    normalizeCommandRows,
    normalizeReferenceRows,
    filterCommandRows,
    filterReferenceRows,
    sanitizeQuote,
    quotePreview,
    formatQuotes,
    MAX_COMMANDS,
    MAX_REFERENCES,
    MAX_QUOTES,
    MAX_QUOTE_CHARS,
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.DshComposerTools = api
})(typeof window === 'undefined' ? globalThis : window)
