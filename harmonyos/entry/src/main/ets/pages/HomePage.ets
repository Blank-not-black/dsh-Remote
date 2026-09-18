import { AppNav } from '../common/AppNav'
import { AppState } from '../services/AppState'
import { Theme, Design } from '../models/Theme'
import { I18n } from '../common/I18n'

/**
 * 主页：连接状态、网关健康、实时通道、Token 概览。
 *
 * 鸿蒙化要点：
 * - 卡片 16vp 大圆角 + 轻投影分层，白卡浮于浅灰底
 * - 可点卡片按压缩放反馈（scale + spring）
 * - Token 数字使用 RollingText 滚动动效
 */
@Component
export struct HomePage {
  @StorageLink('appState') appState: AppState = AppState.instance
  /** 深浅判定（AppState 写入）；变更驱动整页刷新 */
  @StorageLink('uiDark') uiDark: boolean = false
  /** 当前主题 id 原语（AppState 写入）；主题切换驱动整页刷新 */
  @StorageLink('uiTheme') uiTheme: string = 'deep-space'
  /** 按压中的卡片 key（动效反馈） */
  @State pressedCard: string = ''
  /** 刷新图标旋转角（每次点击 +360，motionCurve 补间） */
  @State spin: number = 0

  aboutToAppear(): void {
    this.appState.refreshHealth()
    this.appState.refreshStats()
    this.appState.fetchAnnouncements()
  }

  private pageBg(): string {
    return Theme.bgOf(Theme.get(this.uiTheme), this.uiDark)
  }

  private accent(): string {
    return Theme.accentOf(Theme.get(this.uiTheme), this.uiDark)
  }

  private press(key: string): void {
    this.pressedCard = key
  }

  private release(): void {
    this.pressedCard = ''
  }

  /** 按压态缩放：按下的卡片轻微缩小，松开回弹 */
  private cardScale(key: string): number {
    return this.pressedCard === key ? Design.PRESS_SCALE : 1
  }

  build() {
    Column() {
      Row() {
        Text(I18n.t('主页', 'Home'))
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
            this.appState.refreshHealth()
            this.appState.refreshStats()
            this.appState.refreshSessions()
            this.appState.fetchAnnouncements()
          })
      }
      .width('100%')
      .padding({ left: Design.PAD_PAGE, right: Design.PAD_PAGE, top: 16 + Design.safeTop(), bottom: 10 })

      Scroll() {
        Column({ space: 12 }) {
          this.statusCard()
          this.pendingCard()
          this.tokenCard()
          this.serverCard()
          this.announcementCard()
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

  private modeColor(): string {
    const m = this.appState.mode
    if (m === 'ws') {
      return Design.SUCCESS
    }
    if (m === 'poll') {
      return Design.WARNING
    }
    if (m === 'connecting') {
      return this.accent()
    }
    if (m === 'error') {
      return Design.DANGER
    }
    return Design.TEXT_HINT(this.uiDark)
  }

  private modeLabel(): string {
    const m = this.appState.mode
    if (m === 'ws') {
      return I18n.t('实时已连接', 'Realtime connected')
    }
    if (m === 'poll') {
      return I18n.t('轮询模式', 'Polling mode')
    }
    if (m === 'connecting') {
      return I18n.t('连接中', 'Connecting')
    }
    if (m === 'error') {
      return I18n.t('连接错误', 'Connection error')
    }
    return I18n.t('未连接', 'Not connected')
  }

  @Builder
  statusCard() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Circle({ width: 10, height: 10 }).fill(this.modeColor())
        Text(this.modeLabel())
          .fontSize(17)
          .fontWeight(FontWeight.Medium)
          .fontColor(Design.TEXT_MAIN(this.uiDark))
        Blank()
        Text(this.appState.statusText)
          .fontSize(12)
          .fontColor(Design.TEXT_SUB(this.uiDark))
      }.width('100%')

      if (this.appState.health) {
        Row() {
          this.healthItem('网关', this.appState.health?.ok ? I18n.t('正常', 'OK') : I18n.t('异常', 'Error'),
            this.appState.health?.ok ? Design.SUCCESS : Design.DANGER)
          this.healthItem('上游', this.appState.health?.upstreamOk ? I18n.t('正常', 'OK') : I18n.t('降级', 'Degraded'),
            this.appState.health?.upstreamOk ? Design.SUCCESS : Design.WARNING)
          this.healthItem('mux', this.appState.health?.eventsMux ? I18n.t('在线', 'Up') : I18n.t('离线', 'Down'),
            this.appState.health?.eventsMux ? Design.SUCCESS : Design.TEXT_HINT(this.uiDark))
          this.healthItem('host', this.appState.health?.eventsHost ? I18n.t('在线', 'Up') : I18n.t('离线', 'Down'),
            this.appState.health?.eventsHost ? Design.SUCCESS : Design.TEXT_HINT(this.uiDark))
        }.width('100%').justifyContent(FlexAlign.SpaceBetween)
      } else {
        Text(this.appState.lastError.length > 0 ? this.appState.lastError : I18n.t('未检测到网关状态', 'Gateway status unavailable'))
          .fontSize(12)
          .fontColor(Design.TEXT_SUB(this.uiDark))
          .width('100%')
      }
    }
    .width('100%')
    .padding(Design.PAD_CARD)
    .backgroundColor(Design.SURFACE(this.uiDark))
    .borderRadius(Design.RADIUS_CARD)
    .shadow(Design.cardShadow(this.uiDark))
    .scale({ x: this.cardScale('status'), y: this.cardScale('status') })
    .animation({ curve: Design.pressCurve })
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.press('status')
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.release()
      }
    })
  }

  @Builder
  healthItem(label: string, value: string, color: string) {
    Column({ space: 4 }) {
      Text(label)
        .fontSize(12)
        .fontColor(Design.TEXT_SUB(this.uiDark))
      Text(value)
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor(color)
    }
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  pendingCard() {
    Column({ space: 8 }) {
      Row() {
        Text(I18n.t('待处理事项', 'Pending items'))
          .fontSize(13)
          .fontColor(Design.TEXT_SUB(this.uiDark))
        Blank()
        if (this.appState.pendingApprovals.length > 0 || this.appState.pendingQuestions.length > 0) {
          Text(I18n.t('需处理 ', 'Needs attention: ') + (this.appState.pendingApprovals.length + this.appState.pendingQuestions.length).toString())
            .fontSize(11)
            .fontColor(Design.WARNING)
            .padding({ left: 8, right: 8, top: 3, bottom: 3 })
            .backgroundColor(Design.warningBg())
            .borderRadius(Design.RADIUS_PILL)
        }
      }.width('100%')
      Text(this.appState.pendingApprovals.length > 0 || this.appState.pendingQuestions.length > 0
        ? I18n.t('审批 ', 'Approvals ') + this.appState.pendingApprovals.length.toString() +
          I18n.t(' · 提问 ', ' · Questions ') + this.appState.pendingQuestions.length.toString()
        : I18n.t('无待处理', 'Nothing pending'))
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .fontColor(Design.TEXT_MAIN(this.uiDark))
        .width('100%')
      Text(I18n.t('审批与提问可在打开会话后处理', 'Handle approvals and questions in the session'))
        .fontSize(12)
        .fontColor(Design.TEXT_HINT(this.uiDark))
        .width('100%')
    }
    .width('100%')
    .padding(Design.PAD_CARD)
    .backgroundColor(Design.SURFACE(this.uiDark))
    .borderRadius(Design.RADIUS_CARD)
    .shadow(Design.cardShadow(this.uiDark))
    .alignItems(HorizontalAlign.Start)
    .scale({ x: this.cardScale('pending'), y: this.cardScale('pending') })
    .animation({ curve: Design.pressCurve })
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.press('pending')
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.release()
      }
    })
  }

  @Builder
  tokenCard() {
    Column({ space: 6 }) {
      Text(I18n.t('近 7 日 Token 用量', 'Token usage, last 7 days'))
        .fontSize(13)
        .fontColor(Design.TEXT_SUB(this.uiDark))
        .width('100%')
      Text(this.formatTokens(this.appState.totalTokens7d))
        .fontSize(30)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.accent())
        .width('100%')
      Text(this.appState.statsText)
        .fontSize(12)
        .fontColor(Design.TEXT_HINT(this.uiDark))
        .width('100%')
    }
    .width('100%')
    .padding(Design.PAD_CARD)
    .backgroundColor(Design.SURFACE(this.uiDark))
    .borderRadius(Design.RADIUS_CARD)
    .shadow(Design.cardShadow(this.uiDark))
    .alignItems(HorizontalAlign.Start)
    .scale({ x: this.cardScale('token'), y: this.cardScale('token') })
    .animation({ curve: Design.pressCurve })
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.press('token')
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.release()
      }
    })
  }

  @Builder
  serverCard() {
    Column({ space: 8 }) {
      Text(I18n.t('当前服务器', 'Current server'))
        .fontSize(13)
        .fontColor(Design.TEXT_SUB(this.uiDark))
        .width('100%')
      Text(this.appState.server ? this.appState.server.normalizedUrl() : I18n.t('未配置', 'Not configured'))
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(Design.TEXT_MAIN(this.uiDark))
        .width('100%')
      if (this.appState.health) {
        Text(I18n.t('网关版本 ', 'Gateway ') + (this.appState.health?.version ?? ''))
          .fontSize(12)
          .fontColor(Design.TEXT_HINT(this.uiDark))
          .width('100%')
      }
    }
    .width('100%')
    .padding(Design.PAD_CARD)
    .backgroundColor(Design.SURFACE(this.uiDark))
    .borderRadius(Design.RADIUS_CARD)
    .shadow(Design.cardShadow(this.uiDark))
    .alignItems(HorizontalAlign.Start)
    // 按压反馈对齐 announcementCard（PRESS_SCALE + pressCurve 弹簧）
    .scale({ x: this.cardScale('server'), y: this.cardScale('server') })
    .animation({ curve: Design.pressCurve })
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.press('server')
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.release()
      }
    })
  }

  @Builder
  announcementCard() {
    Column({ space: 8 }) {
      Row() {
        Text(I18n.t('公告', 'Announcements'))
          .fontSize(13)
          .fontColor(Design.TEXT_SUB(this.uiDark))
        Blank()
        if (this.appState.unseenCount() > 0) {
          Text(this.appState.unseenCount().toString() + I18n.t(' 条未读', ' unread'))
            .fontSize(11)
            .fontColor(Design.DANGER)
            .padding({ left: 8, right: 8, top: 3, bottom: 3 })
            .backgroundColor(Design.dangerBg())
            .borderRadius(Design.RADIUS_PILL)
        }
      }.width('100%')
      Text(this.appState.announcements.length > 0
        ? I18n.t('查看最新公告与投票', 'Latest announcements and polls')
        : I18n.t('暂无公告（进入页面时刷新）', 'No announcements yet'))
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .fontColor(Design.TEXT_MAIN(this.uiDark))
        .width('100%')
      Text(I18n.t('点击进入公告中心', 'Tap to open announcement center'))
        .fontSize(12)
        .fontColor(Design.TEXT_HINT(this.uiDark))
        .width('100%')
    }
    .width('100%')
    .padding(Design.PAD_CARD)
    .backgroundColor(Design.SURFACE(this.uiDark))
    .borderRadius(Design.RADIUS_CARD)
    .shadow(Design.cardShadow(this.uiDark))
    .alignItems(HorizontalAlign.Start)
    .scale({ x: this.cardScale('ann'), y: this.cardScale('ann') })
    .animation({ curve: Design.pressCurve })
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.press('ann')
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.release()
      }
    })
    .onClick(() => {
      AppNav.push(AppNav.R_ANNOUNCEMENTS)
    })
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
}
