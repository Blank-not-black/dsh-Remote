import { AppNav } from '../common/AppNav'
import { AppState } from '../services/AppState'
import { StorageService } from '../services/StorageService'
import { Announcement, PollOption } from '../models/Announcement'
import { I18n } from '../common/I18n'
import { Theme, Design } from '../models/Theme'

/**
 * 公告中心：列表 + 详情 + 投票。
 */
@Component
export struct AnnouncementsPageView {
  @StorageLink('appState') appState: AppState = AppState.instance
  /** 深浅判定（AppState 写入）；变更驱动整页刷新 */
  @StorageLink('uiDark') uiDark: boolean = false
  /** 当前主题 id 原语（AppState 写入）；主题切换驱动整页刷新 */
  @StorageLink('uiTheme') uiTheme: string = 'deep-space'

  @State selectedId: string = ''
  @State voteOptionId: string = ''
  @State voteMsg: string = ''
  /** 历史公告弹层 */
  @State showHistory: boolean = false

  private surface(): string {
    return Design.SURFACE(this.uiDark)
  }

  private pageBgOrBlue(): string {
    return Theme.bgOf(Theme.get(this.uiTheme), this.uiDark)
  }

  /** 链接/主操作色：跟随主题主色 */
  private accentOrBlue(): string {
    return Theme.accentOf(Theme.get(this.uiTheme), this.uiDark)
  }

  aboutToAppear(): void {
    this.appState.fetchAnnouncements()
    if (this.appState.announcements.length > 0) {
      this.selectedId = this.appState.announcements[0].id
      this.appState.markSeen(this.selectedId)
    }
  }

  private selected(): Announcement | null {
    for (const a of this.appState.announcements) {
      if (a.id === this.selectedId) {
        return a
      }
    }
    return null
  }

  private openDetail(id: string): void {
    this.selectedId = id
    this.voteOptionId = ''
    this.voteMsg = ''
    this.appState.markSeen(id)
  }

  private async submitVote(announcementId: string, pollId: string): Promise<void> {
    if (this.voteOptionId.length === 0) {
      this.voteMsg = I18n.t('请先选择选项', 'Pick an option first')
      return
    }
    const ok = await this.appState.submitVote(announcementId, pollId, this.voteOptionId)
    this.voteMsg = ok ? I18n.t('投票已提交', 'Vote submitted') : I18n.t('投票失败，请稍后重试', 'Vote failed, try again later')
  }

  private timeLabel(a: Announcement): string {
    if (a.publishedAt <= 0) {
      return ''
    }
    const d = new Date(a.publishedAt)
    const pad = (n: number): string => n < 10 ? '0' + n : String(n)
    return d.getFullYear().toString() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
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
        Text(I18n.t('公告', 'Announcements'))
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .fontColor(Design.TEXT_MAIN(this.uiDark))
          .margin({ left: 4 })
        Blank()
        Text(I18n.t('历史公告', 'History'))
          .fontSize(13)
          .fontColor(this.accentOrBlue())
          .padding({ left: 10, right: 10, top: 4, bottom: 4 })
          .backgroundColor(Design.FILL_LIGHT(this.uiDark))
          .borderRadius(Design.RADIUS_PILL)
          .onClick(() => {
            this.showHistory = true
          })
      }
      .width('100%')
      .padding({ left: 12, right: 16, top: 10 + Design.safeTop(), bottom: 10 })
      .backgroundColor(this.surface())

      Scroll() {
        Column({ space: 12 }) {
          // 列表
          if (this.appState.announcements.length === 0) {
            Text(I18n.t('暂无公告', 'No announcements'))
              .fontSize(14)
              .fontColor(Design.TEXT_HINT(this.uiDark))
              .width('100%')
              .padding(24)
              .textAlign(TextAlign.Center)
          } else {
            Column({ space: 6 }) {
              ForEach(this.appState.announcements, (a: Announcement) => {
                Row() {
                  Column({ space: 2 }) {
                    Text(a.title)
                      .fontSize(15)
                      .fontWeight(this.selectedId === a.id ? FontWeight.Bold : FontWeight.Medium)
                      .fontColor(Design.TEXT_MAIN(this.uiDark))
                      .maxLines(1)
                      .textOverflow({ overflow: TextOverflow.Ellipsis })
                    Text(this.timeLabel(a))
                      .fontSize(11)
                      .fontColor(Design.TEXT_HINT(this.uiDark))
                  }
                  .alignItems(HorizontalAlign.Start)
                  .layoutWeight(1)

                  if (!this.appState.isSeen(a.id)) {
                    Circle({ width: 8, height: 8 })
                      .fill(Design.DANGER)
                  }
                }
                .width('100%')
                .padding(12)
                .backgroundColor(this.selectedId === a.id ? Design.chipBgStrong(this.accentOrBlue()) : this.surface())
                .borderRadius(Design.RADIUS_CARD)
                .onClick(() => {
                  this.openDetail(a.id)
                })
              }, (a: Announcement) => a.id)
            }
          }

          // 详情
          if (this.selected()) {
            Column({ space: 10 }) {
              Text(this.selected()?.title ?? '')
                .fontSize(18)
                .fontWeight(FontWeight.Bold)
                .fontColor(Design.TEXT_MAIN(this.uiDark))
                .width('100%')
              Text(this.timeLabel(this.selected() as Announcement))
                .fontSize(12)
                .fontColor(Design.TEXT_HINT(this.uiDark))
                .width('100%')
              Text(this.selected()?.content ?? '')
                .fontSize(14)
                .fontColor(Design.TEXT_MAIN(this.uiDark))
                .width('100%')
                .copyOption(CopyOptions.LocalDevice)

              if (this.selected()?.poll) {
                Column({ space: 8 }) {
                  Text(I18n.t('投票：', 'Poll: ') + (this.selected()?.poll?.question ?? ''))
                    .fontSize(15)
                    .fontWeight(FontWeight.Medium)
                    .fontColor(Design.TEXT_MAIN(this.uiDark))
                    .width('100%')
                  ForEach(this.selected()?.poll?.options ?? [], (opt: PollOption) => {
                    Row() {
                      Text(this.appState.voteFor(this.selected()?.id ?? '', this.selected()?.poll?.id ?? '') === opt.id ? '☑ ' : '☐ ')
                        .fontSize(14)
                        .fontColor(this.accentOrBlue())
                      Column({ space: 2 }) {
                        Text(opt.label)
                          .fontSize(13)
                          .fontColor(Design.TEXT_MAIN(this.uiDark))
                        if (opt.description.length > 0) {
                          Text(opt.description)
                            .fontSize(11)
                            .fontColor(Design.TEXT_HINT(this.uiDark))
                        }
                      }
                      .alignItems(HorizontalAlign.Start)
                    }
                    .width('100%')
                    .padding({ top: 4, bottom: 4 })
                    .onClick(() => {
                      this.voteOptionId = opt.id
                    })
                  }, (opt: PollOption) => opt.id)

                  if (this.appState.voteFor(this.selected()?.id ?? '', this.selected()?.poll?.id ?? '').length > 0) {
                    Text(I18n.t('已参与投票', 'Vote recorded'))
                      .fontSize(13)
                      .fontColor(Design.SUCCESS)
                      .width('100%')
                  } else {
                    Button(I18n.t('提交投票', 'Submit vote'))
                      .fontSize(14)
                      .height(36)
                      .width('100%')
                      .backgroundColor(this.accentOrBlue())
                      .onClick(() => {
                        this.submitVote(this.selected()?.id ?? '', this.selected()?.poll?.id ?? '')
                      })
                  }
                  if (this.voteMsg.length > 0) {
                    Text(this.voteMsg)
                      .fontSize(12)
                      .fontColor(Design.WARNING)
                      .width('100%')
                  }
                }
                .width('100%')
                .padding(12)
                .backgroundColor(Design.FILL_LIGHT(this.uiDark))
                .borderRadius(Design.RADIUS_CARD)
                .alignItems(HorizontalAlign.Start)
              }

              if (this.selected()?.actionUrl && (this.selected()?.actionUrl ?? '').length > 0) {
                Text(I18n.t('打开链接 ↗', 'Open link ↗'))
                  .fontSize(13)
                  .fontColor(this.accentOrBlue())
                  .width('100%')
                  .onClick(() => {
                    const url = this.selected()?.actionUrl ?? ''
                    if (url.length > 0) {
                      StorageService.getContext()?.openLink(url)
                    }
                  })
              }
            }
            .width('100%')
            .padding(16)
            .backgroundColor(this.surface())
            .borderRadius(Design.RADIUS_CARD)
            .alignItems(HorizontalAlign.Start)
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
    .bindSheet($$this.showHistory, this.historySheet(), {
      height: 460,
      showClose: true,
      title: { title: I18n.t('历史公告', 'History') },
      backgroundColor: this.surface()
    })
  }

  /** 历史公告弹层：本地收过的公告（合并去重，倒序，≤50 条） */
  @Builder
  historySheet() {
    Column() {
      if (this.appState.announcementHistory.length === 0) {
        Text(I18n.t('本地暂无公告历史', 'No announcement history yet'))
          .fontSize(13)
          .fontColor(Design.TEXT_HINT(this.uiDark))
          .width('100%')
          .padding(24)
          .textAlign(TextAlign.Center)
      } else {
        List({ space: 6 }) {
          ForEach(this.appState.announcementHistory, (a: Announcement) => {
            ListItem() {
              Row() {
                Column({ space: 2 }) {
                  Text(a.title)
                    .fontSize(14)
                    .fontColor(Design.TEXT_MAIN(this.uiDark))
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                  Text(this.timeLabel(a))
                    .fontSize(11)
                    .fontColor(Design.TEXT_HINT(this.uiDark))
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)
              }
              .width('100%')
              .padding(12)
              .backgroundColor(Design.FILL_LIGHT(this.uiDark))
              .borderRadius(Design.RADIUS_CONTROL)
              .onClick(() => {
                // 历史条目若仍在有效期内则跳详情
                this.showHistory = false
                this.openDetail(a.id)
              })
            }
          }, (a: Announcement) => a.id)
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 4, bottom: 16 })
      }
    }
    .width('100%')
  }
}

/**
 * @Entry 路由页壳（手机端 router 入口）：直接转发到可内嵌的 AnnouncementsPageView。
 * 平板分栏由 TabletIndex 的 navDestination builder 直接挂 AnnouncementsPageView。
 */
@Entry
@Component
struct AnnouncementsPage {
  build() {
    Column() {
      AnnouncementsPageView()
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
