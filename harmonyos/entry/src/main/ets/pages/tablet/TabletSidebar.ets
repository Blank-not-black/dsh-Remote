import { Theme, Design } from '../../models/Theme'
import { AppNav } from '../../common/AppNav'
import { AppState } from '../../services/AppState'
import { SessionView } from '../../models/SessionView'
import { WorkspaceGroup } from '../../models/WorkspaceGroup'
import { I18n } from '../../common/I18n'

/**
 * 平板侧栏（Navigation 的 navBar 区域），会话列表对齐手机端
 * SessionsPage 的工作区分组折叠：按 cwd 分组、组头可展开/收起
 * （有运行中会话的组强制展开）、默认隐藏已归档会话。组头为轻量
 * 行形态（侧栏窄，不用手机端的大卡片投影），组内会话行跟随桌面端
 * 单行样式，点击会话即替换右栏内容。
 */
@Component
export struct TabletSidebar {
  @StorageLink('appState') appState: AppState = AppState.instance
  @StorageLink('uiDark') uiDark: boolean = false
  @StorageLink('uiTheme') uiTheme: string = 'deep-space'
  /** 当前选中的 nav 项（'' = 未选中，例如右栏是会话详情） */
  @StorageLink('tabletNav') tabletNav: string = ''
  /** 按压中的会话卡片 */
  @State pressedId: string = ''
  /** 收起的分组 key 集合（默认全部展开；有运行中会话的组强制展开） */
  @State collapsedKeys: string[] = []

  aboutToAppear(): void {
    this.appState.refreshSessions()
  }

  private pageBg(): string {
    return Theme.bgOf(Theme.get(this.uiTheme), this.uiDark)
  }

  private accent(): string {
    return Theme.accentOf(Theme.get(this.uiTheme), this.uiDark)
  }

  /** 分组数据：默认视图隐藏已归档会话（与手机端 groups() 同源） */
  private groups(): WorkspaceGroup[] {
    const archived = new Set<string>(this.appState.archivedSessionIds)
    const visible = this.appState.sessions.filter((s: SessionView) => !archived.has(s.sessionId))
    return WorkspaceGroup.build(visible)
  }

  /** 分组是否收起；有运行中会话的组始终视为展开 */
  private isCollapsed(g: WorkspaceGroup): boolean {
    if (g.sessions.some((s: SessionView) => s.running)) {
      return false
    }
    return this.collapsedKeys.indexOf(g.key) >= 0
  }

  private toggleGroup(g: WorkspaceGroup): void {
    const collapsing = !this.isCollapsed(g)
    this.getUIContext().animateTo({
      curve: Design.motionCurve
    }, () => {
      if (collapsing) {
        this.collapsedKeys = [...this.collapsedKeys, g.key]
      } else {
        this.collapsedKeys = this.collapsedKeys.filter((k: string) => k !== g.key)
      }
    })
  }

  /** 状态点颜色：运行中绿 / 空白警示 / 空闲灰 */
  private statusColor(item: SessionView): string {
    if (item.running) {
      return Design.SUCCESS
    }
    if (item.blank) {
      return Design.WARNING
    }
    return Design.TEXT_HINT(this.uiDark)
  }

  /** 侧栏会话行：桌面端为单行标题 + 次行时间/工作区 */
  @Builder
  sessionRow(item: SessionView) {
    Row({ space: 8 }) {
      Circle({ width: 7, height: 7 }).fill(this.statusColor(item))
      Column({ space: 2 }) {
        Text(item.displayLabel())
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .fontColor(Design.TEXT_MAIN(this.uiDark))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(item.updatedLabel())
          .fontSize(11)
          .fontColor(Design.TEXT_HINT(this.uiDark))
          .maxLines(1)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      if (item.running) {
        Text(item.statusLabel())
          .fontSize(10)
          .fontColor(Design.SUCCESS)
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .backgroundColor(Design.successBg())
          .borderRadius(Design.RADIUS_PILL)
      }
    }
    .width('100%')
    .padding({ left: 10, right: 10, top: 9, bottom: 9 })
    .borderRadius(Design.RADIUS_CONTROL)
    .scale({
      x: this.pressedId === item.sessionId ? Design.PRESS_SCALE : 1,
      y: this.pressedId === item.sessionId ? Design.PRESS_SCALE : 1
    })
    .animation({ curve: Design.pressCurve })
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.pressedId = item.sessionId
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.pressedId = ''
      }
    })
    .onClick(() => {
      this.tabletNav = ''
      AppNav.openChat(item.sessionId)
    })
    // 长按弹出会话操作菜单（归档/取消归档、删除）
    // outlineWidth(0)：系统默认给菜单背板加一圈描边（真机上呈黑色外框），
    // 显式置 0 去掉；圆角/背板色/投影由 sessionMenu 自绘内容承担。
    .bindContextMenu(this.sessionMenu(item), ResponseType.LongPress, {
      outlineWidth: 0,
      borderRadius: Design.RADIUS_CONTROL,
      backgroundColor: Design.SURFACE(this.uiDark),
      backgroundBlurStyle: BlurStyle.NONE
    })
  }

  /** 会话操作菜单项（图标 + 文字），danger 为 true 时红色警示 */
  @Builder
  menuRow(label: string, icon: Resource, danger: boolean, onPick: () => void) {
    Row({ space: 8 }) {
      Image(icon)
        .width(16)
        .height(16)
        .fillColor(danger ? Design.DANGER : Design.TEXT_MAIN(this.uiDark))
      Text(label)
        .fontSize(14)
        .fontColor(danger ? Design.DANGER : Design.TEXT_MAIN(this.uiDark))
    }
    .width('100%')
    .padding({ left: 12, right: 16, top: 10, bottom: 10 })
    .onClick(() => {
      onPick()
    })
  }

  /** 长按菜单内容：归档（或取消归档）。
   * 删除项暂时隐藏：DSH 上游（0.1.5-rc.1）RPC 面没有 session.delete，
   * 点击必然报"方法不存在"；待上游提供后恢复 confirmDelete 入口
   * （deleteSession 链路已就绪，见 AppState.deleteSession）。 */
  @Builder
  sessionMenu(item: SessionView) {
    Column() {
      if (this.appState.archivedSessionIds.indexOf(item.sessionId) >= 0) {
        this.menuRow(I18n.t('取消归档', 'Unarchive'), $r('app.media.ic_back'), false, () => {
          this.appState.unarchiveSession(item.sessionId)
        })
      } else {
        this.menuRow(I18n.t('归档会话', 'Archive'), $r('app.media.ic_folder'), false, () => {
          this.confirmArchive(item)
        })
      }
    }
    .width(168)
    .borderRadius(Design.RADIUS_CONTROL)
    .backgroundColor(Design.SURFACE(this.uiDark))
    .shadow(Design.cardShadow(this.uiDark))
    .clip(true)
  }

  /** 删除会话：二次确认（不可恢复） */
  private confirmDelete(item: SessionView): void {
    AlertDialog.show({
      title: I18n.t('删除会话', 'Delete session'),
      message: I18n.t('删除「' + item.displayLabel() + '」？该操作不可恢复。', 'Delete ' + item.displayLabel() + '? This cannot be undone.'),
      primaryButton: { value: I18n.t('取消', 'Cancel'), action: () => { } },
      secondaryButton: {
        value: I18n.t('删除', 'Delete'),
        fontColor: Design.DANGER,
        action: () => {
          this.appState.deleteSession(item.sessionId)
        }
      }
    })
  }

  /** 归档会话：确认后走 AppState（与手机端同一确认弹窗语义） */
  private confirmArchive(item: SessionView): void {
    AlertDialog.show({
      title: I18n.t('归档会话', 'Archive session'),
      message: I18n.t('归档「' + item.displayLabel() + '」？', 'Archive ' + item.displayLabel() + '?'),
      primaryButton: { value: I18n.t('取消', 'Cancel'), action: () => { } },
      secondaryButton: {
        value: I18n.t('归档', 'Archive'),
        action: () => {
          this.appState.archiveSession(item.sessionId)
        }
      }
    })
  }

  /** 底部导航项（对齐桌面端 ds-nav-item：图标 + 文字，选中主色） */
  @Builder
  navItem(label: string, icon: Resource, route: string) {
    Row({ space: 8 }) {
      Image(icon)
        .width(18)
        .height(18)
        .fillColor(this.tabletNav === route ? this.accent() : Design.TEXT_HINT(this.uiDark))
      Text(label)
        .fontSize(13)
        .fontColor(this.tabletNav === route ? this.accent() : Design.TEXT_MAIN(this.uiDark))
      Blank()
    }
    .width('100%')
    .padding({ left: 10, right: 10, top: 9, bottom: 9 })
    .borderRadius(Design.RADIUS_CONTROL)
    .backgroundColor(this.tabletNav === route ? Design.chipBg(this.accent()) : Color.Transparent)
    .animation({ curve: Design.pressCurve })
    .onClick(() => {
      this.tabletNav = route
      AppNav.switchMain(route)
    })
  }

  build() {
    Column() {
      // 品牌行（对齐桌面端 ds-brand）
      Row({ space: 8 }) {
        Text('◆')
          .fontSize(20)
          .fontColor(this.accent())
        Text('DSH Remote')
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor(Design.TEXT_MAIN(this.uiDark))
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: Design.safeTop() + 14, bottom: 8 })

      // 新会话（对齐桌面端 ds-new-session 的主按钮）：实心主色 + 图标，
      // 旧样式（淡主色底 + 文字＋号）在浅色主题下对比弱、观感像禁用项
      Button() {
        Row({ space: 6 }) {
          Image($r('app.media.ic_add'))
            .width(16)
            .height(16)
            .fillColor(Color.White)
          Text(I18n.t('新会话', 'New session'))
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor(Color.White)
        }
        .alignItems(VerticalAlign.Center)
      }
      .height(38)
      .width('100%')
      .backgroundColor(this.accent())
      .borderRadius(Design.RADIUS_CONTROL)
      .margin({ bottom: 8 })
      .onClick(() => {
        // 与手机端 SessionsPage.createAndEnter 的默认创建一致（不指定工作区）
        this.tabletNav = ''
        this.appState.createSession('').then((sessionId: string) => {
          if (sessionId.length > 0) {
            AppNav.openChat(sessionId)
          }
        })
      })

      Text(I18n.t('会话', 'Sessions'))
        .fontSize(11)
        .fontWeight(FontWeight.Bold)
        .fontColor(Design.TEXT_HINT(this.uiDark))
        .width('100%')
        .textAlign(TextAlign.Start)
        .padding({ left: 12, top: 4, bottom: 4 })

      // 会话列表：工作区分组折叠（对齐手机端 SessionsPage）。
      // 每个工作区一个浅色背板块（SURFACE_SUB + 细边框），与页面底色分层，
      // 一眼区分「工作区容器」和其内的会话行。
      List({ space: 8 }) {
        ForEach(this.groups(), (g: WorkspaceGroup) => {
          ListItem() {
            Column({ space: 2 }) {
              // 分组头：箭头随收放旋转 + 工作区名 + 会话数 + 运行中角标
              Row({ space: 6 }) {
                Text('▸')
                  .fontSize(12)
                  .fontColor(Design.TEXT_HINT(this.uiDark))
                  .width(14)
                  .rotate({ angle: this.isCollapsed(g) ? 0 : 90 })
                  .animation({ curve: Design.motionCurve })
                Text(g.name)
                  .fontSize(13)
                  .fontWeight(FontWeight.Medium)
                  .fontColor(Design.TEXT_MAIN(this.uiDark))
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .layoutWeight(1)
                Text(g.sessions.length.toString())
                  .fontSize(11)
                  .fontColor(Design.TEXT_HINT(this.uiDark))
                if (g.sessions.some((s: SessionView) => s.running)) {
                  Circle({ width: 7, height: 7 }).fill(Design.SUCCESS)
                }
              }
              .width('100%')
              .padding({ left: 8, right: 8, top: 7, bottom: 7 })
              .borderRadius(Design.RADIUS_CONTROL)
              .onClick(() => {
                this.toggleGroup(g)
              })

              // 展开的组：组内会话行（已按更新时间倒序）
              if (!this.isCollapsed(g)) {
                ForEach(g.sessions, (item: SessionView) => {
                  this.sessionRow(item)
                }, (item: SessionView) => item.sessionId + '#' + item.updatedAt.toString())
              }
            }
            .width('100%')
            .padding({ top: 3, bottom: 3 })
            .backgroundColor(Design.SURFACE_SUB(this.uiDark))
            .borderRadius(Design.RADIUS_CARD)
            // 1.5vp 描边 + 加深一档的边色（borderHair 太淡，0.5vp 时几乎不可见）
            .border({
              width: 1.5,
              color: this.uiDark ? '#40FFFFFF' : '#33000000'
            })
          }
        }, (g: WorkspaceGroup) => g.key + '#' + g.sessions.length.toString())
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Auto)
      .edgeEffect(EdgeEffect.Spring)
      .padding({ left: 6, right: 6 })

      // 底部导航（对齐桌面端 ds-sidebar-foot）
      Column({ space: 2 }) {
        Divider()
          .color(Design.borderHair(this.uiDark))
          .margin({ bottom: 6 })
        this.navItem(I18n.t('主页', 'Overview'), $r('app.media.ic_home'), AppNav.R_HOME)
        this.navItem(I18n.t('文件', 'Files'), $r('app.media.ic_folder'), AppNav.R_FILES)
        this.navItem(I18n.t('统计', 'Stats'), $r('app.media.ic_stats'), AppNav.R_STATS)
        this.navItem(I18n.t('设置', 'Settings'), $r('app.media.ic_settings'), AppNav.R_SETTINGS)
      }
      .width('100%')
      .padding({ left: 6, right: 6, bottom: Design.safeBottom() + 10 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.pageBg())
  }
}
