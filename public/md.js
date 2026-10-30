/* DSH Remote 轻量 Markdown 渲染器 · 零依赖
 * 用法: mdToHtml(text) -> HTML 字符串
 * 安全: 先 HTML 转义再转标记; 链接仅允许 http/https, 其余保留为纯文本。
 * 支持: 代码块 / 行内代码 / #~### 标题 / **粗体** / *斜体* / - 无序列表 /
 *       1. 有序列表 / > 引用 / GFM 表格 / [text](url) 链接 / 换行。
 * 同时支持浏览器全局 window.mdToHtml 与 Node CommonJS module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./genui.js'), require('./chat-files.js'))
  else root.mdToHtml = factory(root.DshGenUi, root.DshChatFiles)
})(typeof self !== 'undefined' ? self : this, function (genui, files) {
  'use strict'

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[c]
    })
  }

  function decodeEntities(s) {
    const entities = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' }
    return String(s).replace(/&(?:amp|quot|lt|gt|#39);/g, entity => entities[entity])
  }

  let imageLabel = '图片'

  /**
   * Markdown images become preview buttons. Remote/data URLs can load directly;
   * local paths are placeholders that the client resolves through the authenticated file API.
   * Returns null when the target is neither an image URL nor a local path.
   */
  function imageHtml(altEscaped, urlEscaped, fileLinks, imageHosts) {
    let raw = String(urlEscaped || '').trim()
    if (raw.startsWith('&lt;') && raw.endsWith('&gt;')) raw = raw.slice(4, -4)
    let target = decodeEntities(raw)
    if (/^file:/i.test(target) && files?.pathOf) target = files.pathOf(target) || target
    const alt = decodeEntities(String(altEscaped || '')).replace(/<[^>]*>/g, '').trim()
    const label = escapeHtml(alt || imageLabel)
    if (Array.isArray(imageHosts)) {
      let allowed = false
      try { const url = new URL(target); allowed = url.protocol === 'https:' && !url.username && !url.password && imageHosts.includes(url.hostname.toLowerCase()) } catch (_) {}
      if (!allowed) return '<span class="md-image-blocked">' + label + '</span>'
      return '<button type="button" class="chat-image" data-chat-image aria-label="' + label + '"><img src="' + escapeHtml(target) + '" alt="' + label + '" loading="lazy" referrerpolicy="no-referrer" draggable="false"></button>'
    }
    if (/^(?:data:image\/|https?:\/\/|\/api\/)/i.test(target)) {
      return '<button type="button" class="chat-image" data-chat-image aria-label="' + label + '">' +
        '<img src="' + escapeHtml(target) + '" alt="' + label + '" loading="lazy" draggable="false"></button>'
    }
    if (!fileLinks) return null
    const local = /^(?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|[^:\s]+[\\/])/.test(target)
      || /^[^:\s]+\.(?:png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(target)
    if (!local) return null
    return '<button type="button" class="chat-image is-loading" data-chat-image data-chat-image-path="' + escapeHtml(target) +
      '" data-chat-image-alt="' + label + '" aria-label="' + label + '"><span class="chat-image-status">' + label + '</span></button>'
  }

  function inline(s, fileLinks, imageHosts) {
    // Pull images out before inline emphasis/link rules so alt text and URLs stay intact.
    const images = []
    s = s.replace(/!\[([^\]]*)\]\(([^)\n]+)\)/g, function (m, alt, url) {
      const html = imageHtml(alt, url, fileLinks, imageHosts)
      if (!html) return m
      images.push(html)
      return '\u0000IMAGE' + (images.length - 1) + '\u0000'
    })
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    s = s.replace(/\[([^\]]+)\]\(([^)\n]+)\)/g, function (m, text, url) {
      url = url.trim()
      if (url.startsWith('&lt;') && url.endsWith('&gt;')) url = url.slice(4, -4)
      let path
      const entities = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' }
      try {
        const raw = url.replace(/&(?:amp|quot|lt|gt);|&#39;/g, entity => entities[entity])
        path = /^file:/i.test(raw) ? files?.pathOf(raw) : decodeURIComponent(raw)
      } catch { return m }
      if (fileLinks && (files?.pathOf(path) || files?.relativePath(path))) return '<a href="#" data-dsh-file-path="' + escapeHtml(path) + '">' + text + '</a>'
      if (!/^https?:\/\//i.test(url) || /\s/.test(url)) return m
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + text + '</a>'
    })
    return images.length ? s.replace(/\u0000IMAGE(\d+)\u0000/g, (m, index) => images[Number(index)] || '') : s
  }

  function tableCells(line) {
    var s = String(line || '').trim()
    if (s.charAt(0) === '|') s = s.slice(1)
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1)
    var cells = []
    var cell = ''
    var escaped = false
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i)
      if (escaped) { cell += c; escaped = false; continue }
      if (c === '\\') { escaped = true; continue }
      if (c === '|') { cells.push(cell.trim()); cell = ''; continue }
      cell += c
    }
    if (escaped) cell += '\\'
    cells.push(cell.trim())
    return cells
  }

  function tableAlignment(cell) {
    var s = String(cell || '').trim()
    if (!/^:?-{3,}:?$/.test(s)) return null
    if (s.charAt(0) === ':' && s.charAt(s.length - 1) === ':') return 'center'
    if (s.charAt(0) === ':') return 'left'
    if (s.charAt(s.length - 1) === ':') return 'right'
    return null
  }

  function tableAt(lines, start) {
    if (start + 1 >= lines.length || !/\|/.test(lines[start]) || !/\|/.test(lines[start + 1])) return null
    var headers = tableCells(lines[start])
    var separators = tableCells(lines[start + 1])
    if (headers.length < 2 || separators.length !== headers.length) return null
    if (!separators.every(function (cell) { return /^:?-{3,}:?$/.test(String(cell || '').trim()) })) return null
    var alignments = separators.map(tableAlignment)
    var rows = []
    var i = start + 2
    while (i < lines.length && lines[i].trim() && /\|/.test(lines[i])) {
      var cells = tableCells(lines[i])
      if (cells.length !== headers.length) break
      rows.push(cells)
      i++
    }
    return { headers: headers, alignments: alignments, rows: rows, next: i }
  }

  function tableHtml(table, fileLinks, imageHosts) {
    function cellTag(tag, value, align) {
      var style = align ? ' style="text-align:' + align + '"' : ''
      return '<' + tag + style + '>' + inline(value, fileLinks, imageHosts) + '</' + tag + '>'
    }
    var head = '<thead><tr>' + table.headers.map(function (value, i) {
      return cellTag('th', value, table.alignments[i])
    }).join('') + '</tr></thead>'
    var body = table.rows.length
      ? '<tbody>' + table.rows.map(function (row) {
        return '<tr>' + row.map(function (value, i) {
          return cellTag('td', value, table.alignments[i])
        }).join('') + '</tr>'
      }).join('') + '</tbody>'
      : ''
    return '<div class="md-table-wrap"><table>' + head + body + '</table></div>'
  }

  function listMarker(line) {
    var match = line.match(/^( {0,3})(?:(\d{1,9})([.)])|([-+*]))( +)(.*)$/)
    if (!match) return null
    return {
      indent: match[1].length,
      kind: match[2] === undefined ? match[4] : match[3],
      ordered: match[2] !== undefined,
      start: Number(match[2]),
      offset: match[0].length - match[6].length,
      text: match[6]
    }
  }

  // Keep blank-separated items in one list, and render indented blocks inside
  // their parent item. Otherwise every loose item becomes a new list at 1.
  function listHtml(lines, start, fileLinks, imageHosts, depth) {
    var first = listMarker(lines[start])
    var i = start
    var items = []
    var loose = false
    function sibling(marker) {
      return marker && marker.indent === first.indent && marker.kind === first.kind && marker.ordered === first.ordered
    }
    while (i < lines.length) {
      var marker = listMarker(lines[i])
      if (!sibling(marker)) break
      var content = [marker.text]
      i++
      while (i < lines.length) {
        if (!lines[i].trim()) {
          var next = i + 1
          while (next < lines.length && !lines[next].trim()) next++
          if (next >= lines.length) break
          if (sibling(listMarker(lines[next]))) { loose = true; i = next; break }
          if (lines[next].search(/\S/) < marker.offset) break
          loose = true
          content.push('')
          i = next
        }
        var current = lines[i]
        if (current.search(/\S/) >= marker.offset) {
          content.push(current.slice(marker.offset))
        } else {
          // Unindented continuation text is allowed until a new block starts.
          if (listMarker(current) || /^(?:#{1,3}\s|&gt;)/.test(current) || tableAt(lines, i)) break
          content.push(current)
        }
        i++
      }
      items.push(renderLines(content, fileLinks, imageHosts, depth + 1))
    }
    var tag = first.ordered ? 'ol' : 'ul'
    var attr = first.ordered && first.start !== 1 ? ' start="' + first.start + '"' : ''
    return {
      html: '<' + tag + attr + '>' + items.map(function (item) {
        // Tight lists omit paragraph wrappers; nested block wrappers stay intact.
        if (!loose) item = item.replace(/^<p>([\s\S]*?)<\/p>/, '$1')
        return '<li>' + item + '</li>'
      }).join('') + '</' + tag + '>',
      next: i
    }
  }

  function renderLines(lines, fileLinks, imageHosts, depth = 0) {
    var html = ''
    var i = 0
    while (i < lines.length) {
      var line = lines[i]
      var t = line.trim()
      if (!t) { i++; continue }
      var h = line.match(/^(#{1,3})\s+(.*)$/)
      if (h) {
        var level = h[1].length
        html += '<h' + level + '>' + inline(h[2], fileLinks, imageHosts) + '</h' + level + '>'
        i++
        continue
      }
      var table = tableAt(lines, i)
      if (table) {
        html += tableHtml(table, fileLinks, imageHosts)
        i = table.next
        continue
      }
      var q = line.match(/^&gt;\s?(.*)$/)
      if (q) {
        html += '<blockquote>' + inline(q[1], fileLinks, imageHosts) + '</blockquote>'
        i++
        continue
      }
      if (depth < 32 && listMarker(line)) {
        var list = listHtml(lines, i, fileLinks, imageHosts, depth)
        html += list.html
        i = list.next
        continue
      }
      var para = []
      while (i < lines.length) {
        var cur = lines[i]
        var ct = cur.trim()
        if (!ct) break
        if (/^(#{1,3})\s+/.test(cur) || /^&gt;\s?/.test(cur) || (depth < 32 && listMarker(cur))) break
        para.push(inline(cur, fileLinks, imageHosts))
        i++
      }
      if (para.length) html += '<p>' + para.join('<br>') + '</p>'
      else {
        // A block-start check can match a line its full parser rejects. Keep
        // that escaped line as text and always advance instead of spinning.
        html += '<p>' + inline(line, fileLinks, imageHosts) + '</p>'
        i++
      }
    }
    return html
  }

  function codeHtml(code, options) {
    var pre = '<pre><code>' + escapeHtml(code) + '</code></pre>'
    return options?.copyCode ? '<div class="chat-code"><button type="button" class="chat-copy-button" data-chat-copy-code>' + escapeHtml(options.copyCodeLabel || '复制代码') + '</button>' + pre + '</div>' : pre
  }
  function mdToHtml(text, options) {
    if (options?.imageLabel) imageLabel = String(options.imageLabel)
    var raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n')
    var parts = raw.split(/```/)
    var out = ''
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var code = parts[i]
        code = code.replace(/^\n/, '')
        if (code.slice(-1) === '\n') code = code.slice(0, -1)
        var fence = code.match(/^([^\n]*)\n([\s\S]*)$/)
        // Wait for the closing fence: streaming partial JSON stays readable as source.
        if (options?.richContent !== false && genui && fence && i < parts.length - 1 && fence[2].length <= 200000) {
          var language = fence[1].trim().toLowerCase()
          try {
            if (/^(?:dsh-ui|json dsh-ui|dsh-ui json)$/.test(language)) {
              out += genui.render(JSON.parse(fence[2])); continue
            }
            if (language === 'html' || language === 'htm') {
              out += genui.html(fence[2]) + '<details><summary>HTML / 源码</summary>' + codeHtml(fence[2], options) + '</details>'; continue
            }
          } catch (_) { /* Invalid or over-budget specs remain source, never execute. */ }
        }
        // A language header belongs to the fence, not to the copied source.
        var content = options?.copyCode && /^[a-zA-Z0-9_+.-]{1,40}[ \t]*\n/.test(parts[i]) && fence ? fence[2] : code
        out += codeHtml(content, options)
      } else {
        var escaped = escapeHtml(parts[i])
        out += renderLines(escaped.split('\n').map(function (line) {
          return line.replace(/^[ \t]+/, function (indent) {
            var spaces = ''
            for (var j = 0; j < indent.length; j++) spaces += indent[j] === '\t' ? ' '.repeat(4 - spaces.length % 4) : ' '
            return spaces
          })
        }), options?.fileLinks === true, options?.imageHosts)
      }
    }
    return out
  }

  return mdToHtml
})
