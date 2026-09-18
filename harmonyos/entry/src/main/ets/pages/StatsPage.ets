import { AppState } from '../services/AppState'
import { Theme, Design } from '../models/Theme'
import { StatsDay } from '../models/StatsDay'
import { I18n } from '../common/I18n'

/**
 * 统计页：近 7 日 Token 柱状趋势、今日费用与四桶分布。
 *
 * 鸿蒙化要点：大圆角卡片 + 轻投影、柱高动画（layout animation）、
 * 今日四桶浅底圆角块。
 */
@Component
export struct StatsPage {
  @StorageLink('appState') appState: AppState = AppState.instance
  /** 深浅判定（AppState 写入）；变更驱动整页刷新 */
  @StorageLink('uiDark') uiDark: boolean = false
  /** 当前主题 id 原语（AppState 写入）；主题切换驱动整页刷新 */
  @StorageLink('uiTheme') uiTheme: string = 'deep-space'
  /** 刷新图标旋转角（每次点击 +360，motionCurve 补间） */
  @State spin: number = 0
  /** 按压中的统计卡片 key（'' = 无） */
  @State pressedCard: string = ''

  aboutToAppear(): void {
    this.appState.refreshStats()
  }

  private pageBg(): string {
    return Theme.bgOf(Theme.get(this.uiTheme), this.uiDark)
  }

  /** 按压态缩放：按下的卡片轻微缩小，松开回弹（对齐主页卡片手感） */
  private cardScale(key: string): number {
    return this.pressedCard === key ? Design.PRESS_SCALE : 1
  }

  private cardBg(): string {
    return Design.SURFACE(this.uiDark)
  }

  private accent(): string {
    return Theme.accentOf(Theme.get(this.uiTheme), this.uiDark)
  }

  build() {
    Column() {
      Row() {
        Text(I18n.t('统计', 'Stats'))
          .fontSize(24)
          .fontWeight(FontWeight.Bold)
          .fontColor(Design.TEXT_MAIN(this.uiDark))
        Blank()
        Image($r('app.media.ic_refresh'))
          .width(22)
          .height(22)
          .fillColor(this.accent())
          .rotate({ angle: this.spin })
          .animation({ curve: Design.motionCurve })
          .onClick(() => {
            this.spin += 360
            this.appState.refreshStats()
          })
      }
      .width('100%')
      .padding({ left: Design.PAD_PAGE, right: Design.PAD_PAGE, top: 16 + Design.safeTop(), bottom: 10 })

      Scroll() {
        Column({ space: 12 }) {
          this.totalCard()
          this.trendCard()
          this.todayCard()
        }
        .padding({ left: Design.PAD_PAGE, right: Design.PAD_PAGE, bottom: 96 })
        .width('100%')
      }
      .layoutWeight(1)
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.pageBg())
  }

  @Builder
  totalCard() {
    Column({ space: 6 }) {
      Text(I18n.t('近 7 日 Token 总量', 'Token total, last 7 days'))
        .fontSize(13)
        .fontColor(Design.TEXT_SUB(this.uiDark))
      Text(this.formatTokens(this.appState.totalTokens7d))
        .fontSize(38)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.accent())
      Text(this.appState.statsText)
        .fontSize(12)
        .fontColor(Design.TEXT_HINT(this.uiDark))
    }
    .width('100%')
    .padding(20)
    .backgroundColor(this.cardBg())
    .borderRadius(Design.RADIUS_CARD)
    .shadow(Design.cardShadow(this.uiDark))
    .alignItems(HorizontalAlign.Center)
    .scale({ x: this.cardScale('total'), y: this.cardScale('total') })
    .animation({ curve: Design.pressCurve })
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.pressedCard = 'total'
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.pressedCard = ''
      }
    })
  }

  @Builder
  trendCard() {
    Column({ space: 10 }) {
      Text(I18n.t('每日 Token 趋势', 'Daily token trend'))
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(Design.TEXT_MAIN(this.uiDark))
        .width('100%')

      if (this.appState.statsDays.length === 0) {
        Text(I18n.t('暂无统计数据', 'No stats yet'))
          .fontSize(13)
          .fontColor(Design.TEXT_HINT(this.uiDark))
          .width('100%')
          .padding({ top: 20, bottom: 20 })
          .textAlign(TextAlign.Center)
      } else {
        Column() {
          Row({ space: 8 }) {
            ForEach(this.appState.statsDays, (d: StatsDay) => {
              Column() {
                Blank()
                Text(this.formatTokens(d.tokens()))
                  .fontSize(9)
                  .fontColor(Design.TEXT_SUB(this.uiDark))
                Column()
                  .width(18)
                  .height(this.barHeight(d.tokens()))
                  .backgroundColor(this.accent())
                  .borderRadius({ topLeft: 4, topRight: 4 })
                  .animation({ curve: Design.motionCurve })
              }
              .width(30)
              .height(130)
              .alignItems(HorizontalAlign.Center)
            }, (d: StatsDay) => d.date)
          }
          .width('100%')

          Row({ space: 8 }) {
            ForEach(this.appState.statsDays, (d: StatsDay) => {
              Text(this.dayLabel(d.date))
                .fontSize(10)
                .fontColor(Design.TEXT_HINT(this.uiDark))
                .width(30)
                .textAlign(TextAlign.Center)
            }, (d: StatsDay) => d.date)
          }
          .width('100%')
        }
        .width('100%')
      }
    }
    .width('100%')
    .padding(Design.PAD_CARD)
    .backgroundColor(this.cardBg())
    .borderRadius(Design.RADIUS_CARD)
    .shadow(Design.cardShadow(this.uiDark))
    .alignItems(HorizontalAlign.Start)
    .scale({ x: this.cardScale('trend'), y: this.cardScale('trend') })
    .animation({ curve: Design.pressCurve })
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.pressedCard = 'trend'
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.pressedCard = ''
      }
    })
  }

  @Builder
  todayCard() {
    Column({ space: 10 }) {
      Text(I18n.t('今日明细', 'Today breakdown'))
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(Design.TEXT_MAIN(this.uiDark))
        .width('100%')

      if (this.today()) {
        Row() {
          Column({ space: 4 }) {
            Text(I18n.t('今日 Token', 'Today tokens'))
              .fontSize(12)
              .fontColor(Design.TEXT_SUB(this.uiDark))
            Text(this.formatTokens(this.today()?.tokens() ?? 0))
              .fontSize(20)
              .fontWeight(FontWeight.Bold)
              .fontColor(Design.TEXT_MAIN(this.uiDark))
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)

          Column({ space: 4 }) {
            Text(I18n.t('估算费用', 'Estimated cost'))
              .fontSize(12)
              .fontColor(Design.TEXT_SUB(this.uiDark))
            Text(this.formatCost(this.today()?.totalCost() ?? 0))
              .fontSize(20)
              .fontWeight(FontWeight.Bold)
              .fontColor(Design.SUCCESS)
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
        }.width('100%')

        Row({ space: 6 }) {
          this.bucket(I18n.t('输入', 'Input'), this.today()?.input ?? 0)
          this.bucket(I18n.t('缓存读', 'Cache read'), this.today()?.cacheRead ?? 0)
          this.bucket(I18n.t('缓存写', 'Cache write'), this.today()?.cacheWrite ?? 0)
          this.bucket(I18n.t('输出', 'Output'), this.today()?.output ?? 0)
        }.width('100%')
      } else {
        Text(I18n.t('今日暂无数据', 'No data today'))
          .fontSize(13)
          .fontColor(Design.TEXT_HINT(this.uiDark))
          .width('100%')
      }
    }
    .width('100%')
    .padding(Design.PAD_CARD)
    .backgroundColor(this.cardBg())
    .borderRadius(Design.RADIUS_CARD)
    .shadow(Design.cardShadow(this.uiDark))
    .alignItems(HorizontalAlign.Start)
    .scale({ x: this.cardScale('today'), y: this.cardScale('today') })
    .animation({ curve: Design.pressCurve })
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.pressedCard = 'today'
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.pressedCard = ''
      }
    })
  }

  @Builder
  bucket(label: string, value: number) {
    Column({ space: 4 }) {
      Text(this.formatTokens(value))
        .fontSize(12)
        .fontWeight(FontWeight.Medium)
        .fontColor(Design.TEXT_MAIN(this.uiDark))
      Text(label)
        .fontSize(11)
        .fontColor(Design.TEXT_HINT(this.uiDark))
    }
    .layoutWeight(1)
    .padding({ top: 10, bottom: 10 })
    .backgroundColor(Design.FILL_LIGHT(this.uiDark))
    .borderRadius(Design.RADIUS_CONTROL)
    .alignItems(HorizontalAlign.Center)
  }

  private maxTokens(): number {
    let m: number = 1
    for (const d of this.appState.statsDays) {
      m = Math.max(m, d.tokens())
    }
    return m
  }

  private barHeight(tokens: number): number {
    const h = Math.round(tokens / this.maxTokens() * 100)
    return Math.max(3, h)
  }

  private dayLabel(date: string): string {
    const parts = date.split('-')
    if (parts.length === 3) {
      return parts[1] + '-' + parts[2]
    }
    return date
  }

  private today(): StatsDay | null {
    const n = this.appState.statsDays.length
    if (n === 0) {
      return null
    }
    return this.appState.statsDays[n - 1]
  }

  private formatTokens(n: number): string {
    if (n >= 1000000) {
      return (n / 1000000).toFixed(1) + 'M'
    }
    if (n >= 1000) {
      return (n / 1000).toFixed(1) + 'K'
    }
    return n.toString()
  }

  private formatCost(n: number): string {
    if (n <= 0) {
      return '¥0'
    }
    if (n >= 1) {
      return '¥' + n.toFixed(2)
    }
    return '¥' + n.toFixed(4)
  }
}
