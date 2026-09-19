import { AppNav } from '../common/AppNav'
import { AppState } from '../services/AppState'
import { Theme, Design } from '../models/Theme'
import { I18n } from '../common/I18n'

/**
 * 反馈表单：类型 / 内容 / 联系方式 / 可选诊断，POST /feedback。
 */
@Component
export struct FeedbackPageView {
  @StorageLink('appState') appState: AppState = AppState.instance
  /** 深浅判定（AppState 写入）；变更驱动整页刷新 */
  @StorageLink('uiDark') uiDark: boolean = false
  /** 当前主题 id 原语（AppState 写入）；主题切换驱动整页刷新 */
  @StorageLink('uiTheme') uiTheme: string = 'deep-space'

  @State fbType: string = 'bug'
  @State fbMsg: string = ''
  @State fbContact: string = ''
  @State includeDiag: boolean = false
  @State resultMsg: string = ''
  @State submitting: boolean = false

  private surface(): string {
    return Design.SURFACE(this.uiDark)
  }

  private pageBgOrBlue(): string {
    return Theme.bgOf(Theme.get(this.uiTheme), this.uiDark)
  }

  /** 主操作色：跟随主题主色 */
  private accentOrBlue(): string {
    return Theme.accentOf(Theme.get(this.uiTheme), this.uiDark)
  }

  build() {
    Column() {
      Row() {
        Row() {
          Image($r('app.media.ic_back'))
            .width(24)
            .height(24)
            .fillColor(Design.TEXT_MAIN(this.uiDark))
        }
        .width(40)
        .height(40)
        .justifyContent(FlexAlign.Center)
        .margin({ left: -8 })
        .borderRadius(Design.RADIUS_PILL)
        .onClick(() => {
          AppNav.back()
        })
        Text(I18n.t('反馈', 'Feedback'))
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .fontColor(Design.TEXT_MAIN(this.uiDark))
          .margin({ left: 4 })
      }
      .width('100%')
      .padding({ left: 12, right: 16, top: 10 + Design.safeTop(), bottom: 10 })
      .backgroundColor(this.surface())

      Scroll() {
        Column({ space: 12 }) {
          // 类型选择
          Row({ space: 8 }) {
            this.typeChip('bug', I18n.t('问题', 'Issue'))
            this.typeChip('suggestion', I18n.t('建议', 'Suggestion'))
            this.typeChip('other', I18n.t('其他', 'Other'))
          }.width('100%')

          TextArea({ text: $$this.fbMsg, placeholder: I18n.t('描述你遇到的问题或建议（必填）…', 'Describe the issue or suggestion (required)…') })
            .height(150)
            .fontSize(14)
            .backgroundColor(this.surface())
            .borderRadius(Design.RADIUS_CARD)

          TextInput({ text: $$this.fbContact, placeholder: I18n.t('联系方式（可选，便于回复）', 'Contact (optional, for replies)') })
            .height(42)
            .fontSize(14)

          Row() {
            Column({ space: 2 }) {
              Text(I18n.t('附带兼容性诊断', 'Attach compatibility diagnostics'))
                .fontSize(15)
                .fontColor(Design.TEXT_MAIN(this.uiDark))
              Text(I18n.t('仅提交脱敏的版本与链路状态快照', 'Only anonymized version and link status snapshot'))
                .fontSize(11)
                .fontColor(Design.TEXT_HINT(this.uiDark))
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)

            Toggle({ type: ToggleType.Switch, isOn: this.includeDiag })
              .onChange((isOn: boolean) => {
                this.includeDiag = isOn
              })
          }
          .width('100%')
          .padding(12)
          .backgroundColor(this.surface())
          .borderRadius(Design.RADIUS_CARD)

          Button(this.submitting ? I18n.t('提交中…', 'Submitting…') : I18n.t('提交反馈', 'Submit'))
            .fontSize(15)
            .height(44)
            .width('100%')
            .backgroundColor(this.submitting ? Design.TEXT_HINT(this.uiDark) : this.accentOrBlue())
            .enabled(!this.submitting)
            .onClick(() => {
              this.submit()
            })

          if (this.resultMsg.length > 0) {
            Text(this.resultMsg)
              .fontSize(13)
              .fontColor(Design.SUCCESS)
              .width('100%')
          }
        }
        .padding(16)
        .width('100%')
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.pageBgOrBlue())
  }

  @Builder
  typeChip(id: string, label: string) {
    Text(label)
      .fontSize(13)
      .padding({ left: 14, right: 14, top: 6, bottom: 6 })
      .backgroundColor(this.fbType === id ? this.accentOrBlue() : Design.SURFACE_SUB(this.uiDark))
      .fontColor(this.fbType === id ? Color.White : Design.TEXT_MAIN(this.uiDark))
      .borderRadius(16)
      .onClick(() => {
        this.fbType = id
      })
  }

  private async submit(): Promise<void> {
    const msg = this.fbMsg.trim()
    if (msg.length === 0) {
      this.resultMsg = I18n.t('请填写反馈内容', 'Feedback content is required')
      return
    }
    if (msg.length > 2000) {
      this.resultMsg = I18n.t('内容过长（最多 2000 字）', 'Too long (max 2000 characters)')
      return
    }
    this.submitting = true
    this.resultMsg = ''
    try {
      const ok = await this.appState.submitFeedback(this.fbType, msg, this.fbContact.trim(), this.includeDiag)
      this.resultMsg = ok ? I18n.t('已提交，感谢反馈', 'Submitted, thanks!') : I18n.t('提交失败，请稍后重试', 'Submit failed, try again later')
      if (ok) {
        this.fbMsg = ''
      }
    } finally {
      this.submitting = false
    }
  }
}

/**
 * @Entry 路由页壳（手机端 router 入口）：直接转发到可内嵌的 FeedbackPageView。
 * 平板分栏由 TabletIndex 的 navDestination builder 直接挂 FeedbackPageView。
 */
@Entry
@Component
struct FeedbackPage {
  build() {
    Column() {
      FeedbackPageView()
    }
    .width('100%')
    .height('100%')
  }

  /**
   * 抽屉式转场：子页自右滑入、底层左移；返回反向。
   * PageTransitionEnter/Exit 只能直写在 pageTransition() 内（ArkUI 语法限制），
   * 参数统一取 Design 抽屉令牌。
   */
  pageTransition(): void {
    PageTransitionEnter({ type: RouteType.Push, duration: Design.DRAWER_DURATION, curve: Design.DRAWER_CURVE })
      .slide(SlideEffect.Right)
    PageTransitionExit({ type: RouteType.Push, duration: Design.DRAWER_DURATION, curve: Design.DRAWER_CURVE })
      .slide(SlideEffect.Left)
    PageTransitionEnter({ type: RouteType.Pop, duration: Design.DRAWER_DURATION, curve: Design.DRAWER_CURVE })
      .slide(SlideEffect.Left)
    PageTransitionExit({ type: RouteType.Pop, duration: Design.DRAWER_DURATION, curve: Design.DRAWER_CURVE })
      .slide(SlideEffect.Right)
  }
}
