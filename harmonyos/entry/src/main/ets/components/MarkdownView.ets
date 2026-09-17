import { common, Want } from '@kit.AbilityKit'
import { Logger } from '../common/Logger'
import { MarkdownParser, MdBlock, MdSpan } from '../common/Markdown'
import { Design } from '../models/Theme'

/**
 * Markdown 渲染组件：把 Markdown 文本渲染成 ArkUI 组件树。
 *
 * 用法：
 *   MarkdownView({ text: item.text })                       // 随深浅模式取默认配色
 *   MarkdownView({ text: content, baseColor: '#FFFFFF', ... followTheme: false })
 *                                                           // 彩底气泡固定配色
 *
 * 颜色/字号通过 @Prop 传入，便于在气泡（白底深字 / 彩底白字）里复用；
 * 未显式传色时（哨兵空串）按 AppStorage('uiDark') 解析默认配色，
 * 深浅切换由持有方重建（页面绑定 @StorageLink('uiDark')）触发。
 * 表格单元格保留原始文本（不做行内样式），这是与 Web 端 md.js 的已知差异。
 */
@Component
export struct MarkdownView {
  @Prop @Watch('onTextChanged') text: string = ''
  /** 正文字色（'' = 随深浅模式取默认） */
  @Prop baseColor: string = ''
  /** 行内代码 / 代码块底色（'' = 随深浅模式取默认） */
  @Prop codeBg: string = ''
  /** 代码块正文字色（'' = 随深浅模式取默认） */
  @Prop codeColor: string = ''
  /** 引用条颜色（'' = 随深浅模式取默认） */
  @Prop quoteBar: string = ''
  /** 链接颜色（'' = 随深浅模式取默认） */
  @Prop accent: string = ''
  /** 正文字号 */
  @Prop baseFontSize: number = 15
  /** 显式传色时置 false：彩底气泡（如用户消息）固定配色，不随模式解析 */
  @Prop followTheme: boolean = true
  /** 深浅判定（父组件从 @StorageLink('uiDark') 传入，建立渲染依赖） */
  @Prop dark: boolean = false

  @State private blocks: MdBlock[] = []

  aboutToAppear(): void {
    this.blocks = MarkdownParser.parse(this.text)
  }

  onTextChanged(): void {
    this.blocks = MarkdownParser.parse(this.text)
  }

  /** 实际正文色：未传时按深浅解析 */
  private baseColorOf(): string {
    if (this.baseColor.length > 0 || !this.followTheme) {
      return this.baseColor
    }
    return Design.TEXT_MAIN(this.dark)
  }

  private codeBgOf(): string {
    if (this.codeBg.length > 0 || !this.followTheme) {
      return this.codeBg
    }
    return Design.SURFACE_SUB(this.dark)
  }

  private codeColorOf(): string {
    if (this.codeColor.length > 0 || !this.followTheme) {
      return this.codeColor
    }
    return Design.TEXT_MAIN(this.dark)
  }

  private quoteBarOf(): string {
    if (this.quoteBar.length > 0 || !this.followTheme) {
      return this.quoteBar
    }
    return Design.borderHair(this.dark)
  }

  private accentOf(): string {
    if (this.accent.length > 0 || !this.followTheme) {
      return this.accent
    }
    return this.dark ? '#6B9BFF' : '#0A59F7'
  }

  build() {
    Column({ space: 6 }) {
      ForEach(this.blocks, (b: MdBlock, idx: number) => {
        this.blockView(b)
      }, (b: MdBlock, idx: number) => idx.toString() + '-' + b.kind)
    }
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  blockView(b: MdBlock) {
    if (b.kind === 'heading') {
      this.flowLines(b.spanLines, this.headingSize(b.level), FontWeight.Bold)
    } else if (b.kind === 'code') {
      this.codeBlock(b)
    } else if (b.kind === 'list') {
      this.listBlock(b)
    } else if (b.kind === 'quote') {
      this.quoteBlock(b)
    } else if (b.kind === 'table') {
      this.tableBlock(b)
    } else {
      this.flowLines(b.spanLines, this.baseFontSize, FontWeight.Normal)
    }
  }

  private headingSize(level: number): number {
    if (level === 1) {
      return this.baseFontSize + 5
    }
    if (level === 2) {
      return this.baseFontSize + 3
    }
    return this.baseFontSize + 1
  }

  /**
   * 多行文本块：每行一个富文本 Text。
   *
   * 行内片段用 Text(){Span} 富文本结构，而不是 Flex({wrap}) 拼独立 Text：
   * Flex 的换行是组件级的，长 span（整句无标记的连续文本）测量时拿到无限宽约束，
   * 不会换行、直接画出气泡边界；Text+Span 由 Text 按容器宽做文本级换行，永不溢出。
   * Text 不设 width：自适应内容、受父链 maxWidth 约束换行，
   * 避免 width('100%') 在自适应宽度气泡里基准漂移导致溢出。
   */
  @Builder
  flowLines(lines: MdSpan[][], size: number, weight: FontWeight) {
    ForEach(lines, (spans: MdSpan[], li: number) => {
      Text() {
        ForEach(spans, (sp: MdSpan, si: number) => {
          this.spanIn(sp, size, weight)
        }, (sp: MdSpan, si: number) => li.toString() + ':' + si.toString())
      }
      .fontSize(size)
      .fontColor(this.baseColorOf())
      .fontWeight(weight)
      .copyOption(CopyOptions.LocalDevice)
    }, (spans: MdSpan[], li: number) => li.toString())
  }

  /** 富文本行内的单个片段（Span 不能设置背景色，code 用等宽字体+配色区分） */
  @Builder
  spanIn(sp: MdSpan, size: number, weight: FontWeight) {
    if (sp.code) {
      Span(sp.text)
        .fontFamily('monospace')
        .fontSize(size - 2)
        .fontColor(this.codeColorOf())
    } else if (sp.link.length > 0) {
      Span(sp.text)
        .fontColor(this.accentOf())
        .decoration({ type: TextDecorationType.Underline, color: this.accentOf() })
        .onClick(() => {
          this.openLink(sp.link)
        })
    } else {
      Span(sp.text)
        .fontWeight(sp.bold ? FontWeight.Bold : weight)
        .fontStyle(sp.italic ? FontStyle.Italic : FontStyle.Normal)
    }
  }

  @Builder
  codeBlock(b: MdBlock) {
    Column({ space: 4 }) {
      if (b.lang.length > 0) {
        Text(b.lang)
          .fontSize(11)
          .fontColor(Design.TEXT_HINT(this.dark))
      }
      Scroll() {
        Text(b.code)
          .fontSize(this.baseFontSize - 2)
          .fontFamily('monospace')
          .fontColor(this.codeColorOf())
          .textAlign(TextAlign.Start)
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .align(Alignment.TopStart)
      .width('100%')
    }
    .alignItems(HorizontalAlign.Start)
    .padding(8)
    .backgroundColor(this.codeBgOf())
    .borderRadius(8)
  }

  @Builder
  listBlock(b: MdBlock) {
    Column({ space: 3 }) {
      ForEach(b.items, (item: MdSpan[], li: number) => {
        Row({ space: 6 }) {
          Text(b.ordered ? (li + 1).toString() + '.' : '•')
            .fontSize(this.baseFontSize)
            .fontColor(this.baseColorOf())
            .constraintSize({ minWidth: 16 })
          Text() {
            ForEach(item, (sp: MdSpan, si: number) => {
              this.spanIn(sp, this.baseFontSize, FontWeight.Normal)
            }, (sp: MdSpan, si: number) => si.toString())
          }
          .fontSize(this.baseFontSize)
          .fontColor(this.baseColorOf())
          .layoutWeight(1)
        }
        .alignItems(VerticalAlign.Top)
        .width('100%')
      }, (item: MdSpan[], li: number) => li.toString())
    }
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  quoteBlock(b: MdBlock) {
    Column() {
      this.flowLines(b.spanLines, this.baseFontSize, FontWeight.Normal)
    }
    .alignItems(HorizontalAlign.Start)
    .padding({ left: 10, top: 2, bottom: 2 })
    .border({ width: { left: 3 }, color: { left: this.quoteBarOf() } })
  }

  @Builder
  tableBlock(b: MdBlock) {
    Column() {
      Row() {
        ForEach(b.headers, (cellSpans: MdSpan[], ci: number) => {
          this.tableCell(cellSpans, ci, b, true)
        }, (cellSpans: MdSpan[], ci: number) => 'h' + ci.toString())
      }
      .width('100%')
      .backgroundColor(this.codeBgOf())

      ForEach(b.rows, (row: MdSpan[][], ri: number) => {
        Row() {
          ForEach(row, (cellSpans: MdSpan[], ci: number) => {
            this.tableCell(cellSpans, ci, b, false)
          }, (cellSpans: MdSpan[], ci: number) => ri.toString() + '-' + ci.toString())
        }
        .width('100%')
      }, (row: MdSpan[][], ri: number) => 'r' + ri.toString())
    }
  }

  /**
   * 表格单元格：Text(){Span} 富文本 + textAlign 对齐。
   *
   * 注意：这里刻意**不放进横向 Scroll**。滚动容器给子元素的宽度约束是无限的，
   * 单元格会按内容全长排布、永不换行，导致后续列被挤出屏幕。
   * 改为每列 layoutWeight(1) 等分宽度 + Text 按列宽自动换行，表格永远适配屏幕。
   */
  @Builder
  tableCell(cellSpans: MdSpan[], colIndex: number, b: MdBlock, isHeader: boolean) {
    Text() {
      ForEach(cellSpans, (sp: MdSpan, si: number) => {
        this.spanIn(sp, this.baseFontSize - 2, isHeader ? FontWeight.Medium : FontWeight.Normal)
      }, (sp: MdSpan, si: number) => si.toString())
    }
    .fontSize(this.baseFontSize - 2)
    .fontColor(this.baseColorOf())
    .textAlign(this.textAlignOf(b, colIndex))
    .layoutWeight(1)
    .padding({ left: 8, right: 8, top: 5, bottom: 5 })
    .border({ width: 0.5, color: Design.tableBorder(this.dark) })
  }

  private textAlignOf(b: MdBlock, colIndex: number): TextAlign {
    if (colIndex >= b.aligns.length) {
      return TextAlign.Start
    }
    const a = b.aligns[colIndex]
    if (a === 'center') {
      return TextAlign.Center
    }
    if (a === 'right') {
      return TextAlign.End
    }
    return TextAlign.Start
  }

  private openLink(url: string): void {
    try {
      const ctx = getContext(this) as common.UIAbilityContext
      const want: Want = { action: 'ohos.want.action.viewData', uri: url }
      ctx.startAbility(want)
    } catch (e) {
      Logger.warn('open link failed')
    }
  }
}
