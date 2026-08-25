/* DSH Remote 轻量 Markdown 渲染器 · 零依赖
 * 用法: mdToHtml(text) -> HTML 字符串
 * 安全: 先 HTML 转义再转标记; 链接仅允许 http/https, 其余保留为纯文本。
 * 支持: 代码块 / 行内代码 / #~### 标题 / **粗体** / *斜体* / - 无序列表 /
 *       1. 有序列表 / > 引用 / GFM 表格 / [text](url) 链接 / 换行。
 * 同时支持浏览器全局 window.mdToHtml 与 Node CommonJS module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.mdToHtml = factory()
})(typeof self !== 'undefined' ? self : this, function () {
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

  function inline(s) {
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, url) {
      url = url.trim()
      if (!/^https?:\/\//i.test(url)) return m
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + text + '</a>'
    })
    return s
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

  function tableHtml(table) {
    function cellTag(tag, value, align) {
      var style = align ? ' style="text-align:' + align + '"' : ''
      return '<' + tag + style + '>' + inline(value) + '</' + tag + '>'
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

  function renderLines(lines) {
    var html = ''
    var i = 0
    while (i < lines.length) {
      var line = lines[i]
      var t = line.trim()
      if (!t) { i++; continue }
      var h = line.match(/^(#{1,3})\s+(.*)$/)
      if (h) {
        var level = h[1].length
        html += '<h' + level + '>' + inline(h[2]) + '</h' + level + '>'
        i++
        continue
      }
      var table = tableAt(lines, i)
      if (table) {
        html += tableHtml(table)
        i = table.next
        continue
      }
      var q = line.match(/^&gt;\s?(.*)$/)
      if (q) {
        html += '<blockquote>' + inline(q[1]) + '</blockquote>'
        i++
        continue
      }
      var ul = line.match(/^[-*]\s+(.*)$/)
      if (ul) {
        var items = []
        while (i < lines.length) {
          var um = lines[i].match(/^[-*]\s+(.*)$/)
          if (!um) break
          items.push(inline(um[1]))
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
          oitems.push(inline(om[1]))
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
        para.push(inline(cur))
        i++
      }
      if (para.length) html += '<p>' + para.join('<br>') + '</p>'
    }
    return html
  }

  function mdToHtml(text) {
    var raw = String(text == null ? '' : text)
    var parts = raw.split(/```/)
    var out = ''
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var code = parts[i]
        code = code.replace(/^\n/, '')
        if (code.slice(-1) === '\n') code = code.slice(0, -1)
        out += '<pre><code>' + escapeHtml(code) + '</code></pre>'
      } else {
        var escaped = escapeHtml(parts[i])
        out += renderLines(escaped.split('\n'))
      }
    }
    return out
  }

  return mdToHtml
})
