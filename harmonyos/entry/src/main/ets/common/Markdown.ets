/**
 * 轻量 Markdown 解析器（ArkTS 版，零依赖）
 *
 * 与 Web 端 public/md.js 保持同一套规则，但产出结构化块而不是 HTML：
 *   Web 端: mdToHtml(text) -> '<p>..</p>'
 *   本端:   MarkdownParser.parse(text) -> MdBlock[]，由 MarkdownView 渲染成 ArkUI 组件
 *
 * 支持：围栏代码块 / 行内代码 / #~### 标题 / **粗体** / *斜体* /
 *       - 与 * 无序列表 / 1. 有序列表 / > 引用 / GFM 表格 / [文本](url) 链接。
 *
 * 安全：链接只接受 http/https；ArkUI 的 Text 本身不解释标记，无注入面。
 * 与 md.js 的差异（有意为之，均为改进）：
 *   1. 围栏代码块会剥掉首行的语言标记（```ts 中的 ts），md.js 会把它留在代码正文里；
 *   2. 行内代码的内容不再参与后续标记解析（md.js 的替换链会误伤代码里的 ** 与 *）。
 */

/** 行内片段：一段带样式的文本 */
export class MdSpan {
  text: string
  bold: boolean
  italic: boolean
  code: boolean
  /** 非空表示这是一个链接（仅 http/https） */
  link: string

  constructor(text: string, bold: boolean, italic: boolean, code: boolean, link: string) {
    this.text = text
    this.bold = bold
    this.italic = italic
    this.code = code
    this.link = link
  }
}

/** 块级元素 */
export class MdBlock {
  /** heading | paragraph | code | list | quote | table */
  kind: string = 'paragraph'
  /** 标题层级 1..3 */
  level: number = 0
  /** paragraph / quote：每一行是若干行内片段（一个换行 = 一行） */
  spanLines: MdSpan[][] = []
  /** list：每一项是若干行内片段 */
  items: MdSpan[][] = []
  ordered: boolean = false
  start: number = 1
  /** code：语言标记与正文 */
  lang: string = ''
  code: string = ''
  /** table：表头每列的若干行内片段 */
  headers: MdSpan[][] = []
  aligns: string[] = []
  /** table：每行 × 每列的若干行内片段 */
  rows: MdSpan[][][] = []
}

/** tableAt 的中间结果 */
class MdTableParse {
  headers: string[] = []
  aligns: string[] = []
  rows: string[][] = []
  next: number = 0
}

export class MarkdownParser {
  private static readonly LINK_RE: RegExp = /^https?:\/\//i
  private static readonly LANG_RE: RegExp = /^[A-Za-z0-9+#._-]{1,20}$/
  private static readonly HEADING_RE: RegExp = /^(#{1,3})\s+(.*)$/
  private static readonly QUOTE_RE: RegExp = /^>\s?(.*)$/
  private static readonly UL_RE: RegExp = /^[-*]\s+(.*)$/
  private static readonly OL_RE: RegExp = /^\d+[.)]\s+(.*)$/
  private static readonly SEP_RE: RegExp = /^:?-{3,}:?$/

  /** 入口：Markdown 文本 → 块列表 */
  static parse(text: string): MdBlock[] {
    const out: MdBlock[] = []
    if (text === null || text === undefined || text.length === 0) {
      return out
    }
    // 围栏代码块按 ``` 切分：奇数段是代码，偶数段是普通文本
    const parts: string[] = text.split('```')
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        out.push(MarkdownParser.buildCode(parts[i]))
      } else {
        MarkdownParser.parseLines(parts[i].split('\n'), out)
      }
    }
    return out
  }

  /** 围栏代码块：剥掉首行语言标记与首尾空行 */
  private static buildCode(raw: string): MdBlock {
    let s = raw
    if (s.startsWith('\n')) {
      s = s.substring(1)
    }
    let lang = ''
    const nl = s.indexOf('\n')
    const firstLine = (nl >= 0 ? s.substring(0, nl) : s).trim()
    if (firstLine.length > 0 && MarkdownParser.LANG_RE.test(firstLine)) {
      lang = firstLine
      s = nl >= 0 ? s.substring(nl + 1) : ''
    }
    if (s.endsWith('\n')) {
      s = s.substring(0, s.length - 1)
    }
    const b = new MdBlock()
    b.kind = 'code'
    b.lang = lang
    b.code = s
    return b
  }

  private static parseLines(lines: string[], out: MdBlock[]): void {
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (line.trim().length === 0) {
        i++
        continue
      }

      const h = MarkdownParser.HEADING_RE.exec(line)
      if (h !== null) {
        const b = new MdBlock()
        b.kind = 'heading'
        b.level = h[1].length
        b.spanLines = [MarkdownParser.inline(h[2])]
        out.push(b)
        i++
        continue
      }

      const table = MarkdownParser.tableAt(lines, i)
      if (table !== null) {
        const b = new MdBlock()
        b.kind = 'table'
        b.aligns = table.aligns
        // 单元格同样做行内解析：否则单元格里的 `code` / **粗体** 会原样显示
        const headerSpans: MdSpan[][] = []
        for (const h of table.headers) {
          headerSpans.push(MarkdownParser.inline(h))
        }
        b.headers = headerSpans
        const rowSpans: MdSpan[][][] = []
        for (const row of table.rows) {
          const cells: MdSpan[][] = []
          for (const c of row) {
            cells.push(MarkdownParser.inline(c))
          }
          rowSpans.push(cells)
        }
        b.rows = rowSpans
        out.push(b)
        i = table.next
        continue
      }

      const q = MarkdownParser.QUOTE_RE.exec(line)
      if (q !== null) {
        const b = new MdBlock()
        b.kind = 'quote'
        b.spanLines = [MarkdownParser.inline(q[1])]
        out.push(b)
        i++
        continue
      }

      if (MarkdownParser.UL_RE.test(line)) {
        const b = new MdBlock()
        b.kind = 'list'
        b.ordered = false
        while (i < lines.length) {
          const um = MarkdownParser.UL_RE.exec(lines[i])
          if (um === null) {
            break
          }
          b.items.push(MarkdownParser.inline(um[1]))
          i++
        }
        out.push(b)
        continue
      }

      const ol = MarkdownParser.OL_RE.exec(line)
      if (ol !== null) {
        const b = new MdBlock()
        b.kind = 'list'
        b.ordered = true
        while (i < lines.length) {
          const om = MarkdownParser.OL_RE.exec(lines[i])
          if (om === null) {
            break
          }
          b.items.push(MarkdownParser.inline(om[1]))
          i++
        }
        out.push(b)
        continue
      }

      // 段落：连续非空且非块起始的行
      const b = new MdBlock()
      b.kind = 'paragraph'
      while (i < lines.length) {
        const cur = lines[i]
        if (cur.trim().length === 0) {
          break
        }
        if (MarkdownParser.HEADING_RE.test(cur) || MarkdownParser.QUOTE_RE.test(cur) ||
          MarkdownParser.UL_RE.test(cur) || MarkdownParser.OL_RE.test(cur)) {
          break
        }
        b.spanLines.push(MarkdownParser.inline(cur))
        i++
      }
      if (b.spanLines.length > 0) {
        out.push(b)
      }
    }
  }

  // ---------------- GFM 表格 ----------------

  private static tableAt(lines: string[], start: number): MdTableParse | null {
    if (start + 1 >= lines.length) {
      return null
    }
    if (lines[start].indexOf('|') < 0 || lines[start + 1].indexOf('|') < 0) {
      return null
    }
    const headers = MarkdownParser.tableCells(lines[start])
    const separators = MarkdownParser.tableCells(lines[start + 1])
    if (headers.length < 2 || separators.length !== headers.length) {
      return null
    }
    const aligns: string[] = []
    for (const cell of separators) {
      const a = MarkdownParser.tableAlign(cell)
      if (a === null) {
        return null
      }
      aligns.push(a)
    }
    const rows: string[][] = []
    let i = start + 2
    while (i < lines.length && lines[i].trim().length > 0 && lines[i].indexOf('|') >= 0) {
      const cells = MarkdownParser.tableCells(lines[i])
      if (cells.length !== headers.length) {
        break
      }
      rows.push(cells)
      i++
    }
    const t = new MdTableParse()
    t.headers = headers
    t.aligns = aligns
    t.rows = rows
    t.next = i
    return t
  }

  /** 按未转义的 | 切分单元格，支持 \| 转义 */
  private static tableCells(line: string): string[] {
    let s = line.trim()
    if (s.startsWith('|')) {
      s = s.substring(1)
    }
    if (s.endsWith('|')) {
      s = s.substring(0, s.length - 1)
    }
    const cells: string[] = []
    let cell = ''
    let escaped = false
    for (let i = 0; i < s.length; i++) {
      const c = s.charAt(i)
      if (escaped) {
        cell += c
        escaped = false
        continue
      }
      if (c === '\\') {
        escaped = true
        continue
      }
      if (c === '|') {
        cells.push(cell.trim())
        cell = ''
        continue
      }
      cell += c
    }
    if (escaped) {
      cell += '\\'
    }
    cells.push(cell.trim())
    return cells
  }

  /** 分隔行 → left / center / right；不是分隔行返回 null */
  private static tableAlign(cell: string): string | null {
    const s = cell.trim()
    if (!MarkdownParser.SEP_RE.test(s)) {
      return null
    }
    const left = s.startsWith(':')
    const right = s.endsWith(':')
    if (left && right) {
      return 'center'
    }
    if (left) {
      return 'left'
    }
    if (right) {
      return 'right'
    }
    return 'left'
  }

  // ---------------- 行内 ----------------

  /**
   * 行内解析：`code` / **粗体** / *斜体* / [文本](url)
   * 优先级与 md.js 一致：代码 > 粗体 > 斜体 > 链接。
   */
  static inline(s: string): MdSpan[] {
    const out: MdSpan[] = []
    if (s === null || s === undefined || s.length === 0) {
      return out
    }
    let plain = ''
    let i = 0
    while (i < s.length) {
      const c = s.charAt(i)

      // 行内代码
      if (c === '`') {
        const end = s.indexOf('`', i + 1)
        if (end > i + 1) {
          MarkdownParser.flush(out, plain)
          plain = ''
          out.push(new MdSpan(s.substring(i + 1, end), false, false, true, ''))
          i = end + 1
          continue
        }
      }

      // 粗体 **...**
      if (c === '*' && i + 1 < s.length && s.charAt(i + 1) === '*') {
        const end = s.indexOf('**', i + 2)
        if (end > i + 2) {
          const inner = s.substring(i + 2, end)
          if (inner.indexOf('*') < 0) {
            MarkdownParser.flush(out, plain)
            plain = ''
            // 内部仍可能有 `code` / [链接]：递归解析并继承粗体。
            // inner 已保证不含 *，递归不会再次进入粗体/斜体分支。
            for (const sp of MarkdownParser.inline(inner)) {
              out.push(new MdSpan(sp.text, true, sp.italic, sp.code, sp.link))
            }
            i = end + 2
            continue
          }
        }
      }

      // 斜体 *...*
      // md.js 的规则是 (^|[^*])\*([^*\n]+)\*：起始 * 的前一个字符不能也是 *
      if (c === '*') {
        const prevIsStar = i > 0 && s.charAt(i - 1) === '*'
        const end = prevIsStar ? -1 : s.indexOf('*', i + 1)
        if (end > i + 1) {
          const inner = s.substring(i + 1, end)
          if (inner.indexOf('*') < 0 && inner.indexOf('\n') < 0) {
            MarkdownParser.flush(out, plain)
            plain = ''
            for (const sp of MarkdownParser.inline(inner)) {
              out.push(new MdSpan(sp.text, sp.bold, true, sp.code, sp.link))
            }
            i = end + 1
            continue
          }
        }
      }

      // 链接 [文本](url)
      if (c === '[') {
        const close = s.indexOf(']', i + 1)
        if (close > i + 1 && close + 1 < s.length && s.charAt(close + 1) === '(') {
          const paren = s.indexOf(')', close + 2)
          if (paren > close + 2) {
            const url = s.substring(close + 2, paren).trim()
            if (MarkdownParser.LINK_RE.test(url) && url.indexOf(' ') < 0) {
              MarkdownParser.flush(out, plain)
              plain = ''
              out.push(new MdSpan(s.substring(i + 1, close), false, false, false, url))
              i = paren + 1
              continue
            }
          }
        }
      }

      plain += c
      i++
    }
    MarkdownParser.flush(out, plain)
    return out
  }

  private static flush(out: MdSpan[], plain: string): void {
    if (plain.length > 0) {
      out.push(new MdSpan(plain, false, false, false, ''))
    }
  }
}
