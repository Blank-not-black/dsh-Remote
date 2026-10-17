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
  function imageHtml(altEscaped, urlEscaped, fileLinks) {
    let raw = String(urlEscaped || '').trim()
    if (raw.startsWith('&lt;') && raw.endsWith('&gt;')) raw = raw.slice(4, -4)
    let target = decodeEntities(raw)
    if (/^file:/i.test(target) && files?.pathOf) target = files.pathOf(target) || target
    const alt = decodeEntities(String(altEscaped || '')).replace(/<[^>]*>/g, '').trim()
    const label = escapeHtml(alt || imageLabel)
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

  function inline(s, fileLinks) {
    // Pull images out before inline emphasis/link rules so alt text and URLs stay intact.
    const images = []
    s = s.replace(/!\[([^\]]*)\]\(([^)\n]+)\)/g, function (m, alt, url) {
      const html = imageHtml(alt, url, fileLinks)
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

  function tableHtml(table, fileLinks) {
    function cellTag(tag, value, align) {
      var style = align ? ' style="text-align:' + align + '"' : ''
      return '<' + tag + style + '>' + inline(value, fileLinks) + '</' + tag + '>'
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

  function renderLines(lines, fileLinks) {
    var html = ''
    var i = 0
    while (i < lines.length) {
      var line = lines[i]
      var t = line.trim()
      if (!t) { i++; continue }
      var h = line.match(/^(#{1,3})\s+(.*)$/)
      if (h) {
        var level = h[1].length
        html += '<h' + level + '>' + inline(h[2], fileLinks) + '</h' + level + '>'
        i++
        continue
      }
      var table = tableAt(lines, i)
      if (table) {
        html += tableHtml(table, fileLinks)
        i = table.next
        continue
      }
      var q = line.match(/^&gt;\s?(.*)$/)
      if (q) {
        html += '<blockquote>' + inline(q[1], fileLinks) + '</blockquote>'
        i++
        continue
      }
      var ul = line.match(/^[-*]\s+(.*)$/)
      if (ul) {
        var items = []
        while (i < lines.length) {
          var um = lines[i].match(/^[-*]\s+(.*)$/)
          if (!um) break
          items.push(inline(um[1], fileLinks))
          i++
        }
        html += '<ul>' + items.map(function (x) { return '<li>' + x + '</li>' }).join('') + '</ul>'
        continue
      }
      var ol = line.match(/^\d+[.)]\s+(.*)$/)
      if (ol) {
        var oitems = []
        while (i < lines.length) {
          var om = lines[i].match(/^\d+[.)]\s+(.*)$/)
          if (!om) break
          oitems.push(inline(om[1], fileLinks))
          i++
        }
        html += '<ol>' + oitems.map(function (x) { return '<li>' + x + '</li>' }).join('') + '</ol>'
        continue
      }
      var para = []
      while (i < lines.length) {
        var cur = lines[i]
        var ct = cur.trim()
        if (!ct) break
        if (/^(#{1,3})\s+/.test(cur) || /^&gt;\s?/.test(cur) || /^[-*]\s+/.test(cur) || /^\d+[.)]\s+/.test(cur)) break
        para.push(inline(cur, fileLinks))
        i++
      }
      if (para.length) html += '<p>' + para.join('<br>') + '</p>'
    }
    return html
  }

  function mdToHtml(text, options) {
    if (options?.imageLabel) imageLabel = String(options.imageLabel)
    var raw = String(text == null ? '' : text)
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
              out += genui.html(fence[2]) + '<details><summary>HTML / 源码</summary><pre><code>' + escapeHtml(fence[2]) + '</code></pre></details>'; continue
            }
          } catch (_) { /* Invalid or over-budget specs remain source, never execute. */ }
        }
        out += '<pre><code>' + escapeHtml(code) + '</code></pre>'
      } else {
        var escaped = escapeHtml(parts[i])
        out += renderLines(escaped.split('\n'), options?.fileLinks === true)
      }
    }
    return out
  }

  return mdToHtml
})
