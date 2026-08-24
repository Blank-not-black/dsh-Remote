/* DSH Remote 轻量 Markdown 渲染器 · 零依赖
 * 用法: mdToHtml(text) -> HTML 字符串
 * 安全: 先 HTML 转义再转标记; 链接仅允许 http/https, 其余保留为纯文本。
 * 支持: 代码块 / 行内代码 / #~### 标题 / **粗体** / *斜体* / - 无序列表 /
 *       1. 有序列表 / > 引用 / [text](url) 链接 / GFM 表格(| 分隔 + 对齐分隔行) / 换行。
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

  /** 按 | 拆分表格行, 去掉行首尾 | 产生的空段。 */
  function splitCells(row) {
    var parts = String(row).split('|')
    if (parts.length && parts[0].trim() === '') parts.shift()
    if (parts.length && parts[parts.length - 1].trim() === '') parts.pop()
    return parts
  }

  /** GFM 表格: 表头行(| a | b |) + 分隔行(| --- | :--: |) + 若干数据行。 */
  function tryParseTable(lines, i) {
    var header = (lines[i] || '').trim()
    if (header.indexOf('|') === -1) return null
    var delim = (lines[i + 1] || '').trim()
    if (delim.indexOf('-') === -1 || !/^\|?[\s:\-|]+\|?$/.test(delim)) return null
    var alignParts = splitCells(delim)
    var headerParts = splitCells(header)
    if (!headerParts.length || alignParts.length !== headerParts.length) return null
    var aligns = alignParts.map(function (c) {
      var v = c.trim()
      if (/^:-+:$/.test(v)) return ' style="text-align:center"'
      if (/^-+:$/.test(v)) return ' style="text-align:right"'
      return ''
    })
    var rows = [headerParts]
    var j = i + 2
    while (j < lines.length) {
      var r = (lines[j] || '').trim()
      if (r.indexOf('|') === -1 || /^(#{1,3})\s+/.test(r) || /^&gt;/.test(r) || /^[-*]\s+/.test(r) || /^\d+[.)]\s+/.test(r)) break
      var cells = splitCells(r)
      if (!cells.length) break
      rows.push(cells)
      j++
    }
    if (rows.length < 2) return null
    var html = '<div class="md-table-wrap"><table><thead><tr>'
    rows[0].forEach(function (c, idx) {
      html += '<th' + (aligns[idx] || '') + '>' + inline(c.trim()) + '</th>'
    })
    html += '</tr></thead><tbody>'
    for (var k = 1; k < rows.length; k++) {
      html += '<tr>'
      for (var c2 = 0; c2 < rows[0].length; c2++) {
        var cell = rows[k][c2] == null ? '' : rows[k][c2].trim()
        html += '<td' + (aligns[c2] || '') + '>' + inline(cell) + '</td>'
      }
      html += '</tr>'
    }
    html += '</tbody></table></div>'
    return { html: html, next: j }
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
      var table = tryParseTable(lines, i)
      if (table) {
        html += table.html
        i = table.next
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
