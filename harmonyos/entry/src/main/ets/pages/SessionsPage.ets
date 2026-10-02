import { AppNav, NavParams } from '../common/AppNav'
import { Theme, Design, sheetSpringBack } from '../models/Theme'
import { AppState } from '../services/AppState'
import { SessionView } from '../models/SessionView'
import { WorkspaceInfo } from '../models/WorkspaceInfo'
import { WorkspaceGroup } from '../models/WorkspaceGroup'
import { SessionListLogic } from '../common/SessionListLogic'
import { SessionActions } from '../common/SessionActions'
import { sessionMenu, SessionMenuParams } from '../components/SessionContextMenu'
import { handoffCard, HandoffCardParams } from '../components/HandoffCard'
import { SkeletonList } from '../components/SkeletonList'
import { I18n } from '../common/I18n'

/**
 * 会话列表：session.list、下拉刷新、新建会话（可选工作区）。
 *
 * 会话按工作区（cwd）分组折叠展示：分组头显示工作区名与会话数，
 * 点击展开/收起组内会话；有运行中会话的组默认展开。
 *
 * 鸿蒙化要点：大圆角卡片 + 轻投影、按压缩放反馈、胶囊状态标签、
 * 新建按钮胶囊形、列表弹性边缘（Spring）。
 */
@Component
export struct SessionsPage {
  @StorageLink('appState') appState: AppState = AppState.instance
  /** 深浅判定（AppState 写入）；变更驱动整页刷新 */
  @StorageLink('uiDark') uiDark: boolean = false
  /** 当前主题 id 原语（AppState 写入）；主题切换驱动整页刷新 */
  @StorageLink('uiTheme') uiTheme: string = 'deep-space'
  @State refreshing: boolean = false
  /** 新建会话弹层 */
  @State showNewSheet: boolean = false
  @State creating: boolean = false
  /** 选中的工作区 id（'' = 不指定） */
  @State selectedWorkspaceId: string = ''
  /** 创建失败提示 */
  @State createNote: string = ''
  /** 按压中的会话卡片 */
  @State pressedId: string = ''
  /** 收起的分组 key 集合（@State 持有驱动重渲染；规则见 SessionListLogic 纯函数） */
  @State collapsedKeys: string[] = []
  /** 分组/过滤纯逻辑（与平板侧栏共享，见 SessionListLogic） */
  private listLogic: SessionListLogic = new SessionListLogic()
  /** 列表视图：false 全部会话（隐藏已归档）/ true 已归档 */
  @State archivedView: boolean = false

  aboutToAppear(): void {
    this.appState.refreshSessions()
    this.appState.refreshWorkspaces()
    this.appState.refreshHandoff()
  }

  private refreshList(): void {
    this.refreshing = true
    this.appState.refreshSessions().then(() => {
      this.appState.refreshWorkspaces().then(() => {
        this.appState.refreshHandoff().then(() => {
          this.refreshing = false
        })
      })
    })
  }

  /** 接续卡片命中会话：指针指向的会话仍在列表里时带出状态（运行中绿点） */
  private handoffSession(): SessionView | null {
    const h = this.appState.handoff
    if (!h) {
      return null
    }
    for (const s of this.appState.sessions) {
      if (s.sessionId === h.sessionId) {
        return s
      }
    }
    return null
  }

  /** 点击接续卡片：跳入指针指向的会话并清掉本地展示（指针留给其他设备） */
  private openHandoff(): void {
    const h = this.appState.handoff
    if (!h) {
      return
    }
    const p = new NavParams()
    p.sessionId = h.sessionId
    this.appState.handoff = null
    AppNav.push(AppNav.R_CHAT, p)
  }

  /** 忽略接续卡片：清网关指针（不再提示） */
  private dismissHandoff(): void {
    this.appState.handoff = null
    this.appState.clearHandoff()
  }

  /** 接续卡片参数（动态值经闭包求值：@Builder 按值传参不建立渲染依赖） */
  private handoffParams(): HandoffCardParams {
    const p = new HandoffCardParams()
    p.handoff = this.appState.handoff
    p.session = this.handoffSession()
    p.getDark = (): boolean => this.uiDark
    p.getAccent = (): string => this.accent()
    p.onOpen = (): void => {
      this.openHandoff()
    }
    p.onDismiss = (): void => {
      this.dismissHandoff()
    }
    return p
  }

  private openNewSheet(): void {
    this.createNote = ''
    this.selectedWorkspaceId = ''
    // 每次打开都刷新工作区列表，保证新绑定的工作区可见
    this.appState.refreshWorkspaces()
    this.showNewSheet = true
  }

  /** 创建会话并跳入；无工作区列表时按未指定创建 */
  private createAndEnter(): void {
    if (this.creating) {
      return
    }
    this.creating = true
    this.createNote = ''
    this.appState.createSession(this.selectedWorkspaceId).then((sessionId: string) => {
      this.creating = false
      if (sessionId.length === 0) {
        this.createNote = this.appState.lastError.length > 0 ? this.appState.lastError : I18n.t('创建会话失败', 'Create session failed')
        return
      }
      this.showNewSheet = false
      const p = new NavParams()
      p.sessionId = sessionId
      AppNav.push(AppNav.R_CHAT, p)
    })
  }

  /** 分组数据：按视图过滤（默认视图隐藏已归档；归档视图只显示已归档） */
  private groups(): WorkspaceGroup[] {
    return this.listLogic.groups(this.appState.sessions, this.appState.archivedSessionIds, this.archivedView)
  }

  /** 归档会话：确认后 workspace.archiveSession（与 Web 端 sc-archive-btn 一致） */
  private confirmArchive(item: SessionView): void {
    SessionActions.confirmArchive(item, () => {
      this.appState.archiveSession(item.sessionId)
    })
  }

  /** 分组是否收起；有运行中会话的组始终视为展开 */
  private isCollapsed(g: WorkspaceGroup): boolean {
    return SessionListLogic.isCollapsedIn(this.collapsedKeys, g, g.sessions)
  }

  private toggleGroup(g: WorkspaceGroup): void {
    // animateTo 包裹状态变更：本次变化涉及的插入/删除走 transition 动画
    // （springMotion 物理曲线下 duration 不生效，时长由弹簧参数决定）
    this.getUIContext().animateTo({
      curve: Design.motionCurve
    }, () => {
      this.collapsedKeys = SessionListLogic.toggleInto(this.collapsedKeys, g, g.sessions)
    })
  }

  private pageBg(): string {
    return Theme.bgOf(Theme.get(this.uiTheme), this.uiDark)
  }

  private cardBg(): string {
    return Design.SURFACE(this.uiDark)
  }

  private accent(): string {
    return Theme.accentOf(Theme.get(this.uiTheme), this.uiDark)
  }

  /** 状态标签颜色：运行中 / 空白 / 空闲（共享规则，见 SessionListLogic） */
  private statusColor(item: SessionView): string {
    return SessionListLogic.statusColor(item, this.uiDark)
  }

  build() {
    Column() {
      Row() {
        Text(I18n.t('会话', 'Sessions'))
          .fontSize(24)
          .fontWeight(FontWeight.Bold)
          .fontColor(Design.TEXT_MAIN(this.uiDark))
        Blank()
        // 新会话按钮：实心主色 + 白色图标文字（对齐平板侧栏主按钮，
        // 旧"＋ 新建"纯文本样式对比弱）
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
        .height(34)
        .padding({ left: 14, right: 14 })
        .backgroundColor(this.accent())
        .borderRadius(Design.RADIUS_PILL)
        .onClick(() => {
          this.openNewSheet()
        })
      }
      .width('100%')
      .padding({ left: Design.PAD_PAGE, right: Design.PAD_PAGE, top: 16 + Design.safeTop(), bottom: 10 })

      // 视图切换：全部 / 已归档（归档计数 > 0 时显示）
      if (this.appState.archivedSessionIds.length > 0) {
        Row({ space: 8 }) {
          this.viewChip(I18n.t('全部', 'All'), (): boolean => !this.archivedView, (): boolean => false)
          this.viewChip(I18n.t('已归档 ', 'Archived ') + this.appState.archivedSessionIds.length.toString(),
            (): boolean => this.archivedView, (): boolean => true)
        }
        .width('100%')
        .padding({ left: Design.PAD_PAGE, right: Design.PAD_PAGE, bottom: 8 })
      }

      Stack() {
        Refresh({ refreshing: $$this.refreshing }) {
          List({ space: 10 }) {
            // 跨端接续卡片：另一设备最近打开的会话（appState.handoff 非空时置顶）
            if (this.appState.handoff !== null) {
              ListItem() {
                handoffCard(this.handoffParams())
              }
            }
            ForEach(this.groups(), (g: WorkspaceGroup) => {
              ListItem() {
                this.groupSection(g)
              }
            }, (g: WorkspaceGroup) => g.key + '#' + g.sessions.length.toString())
          }
          .width('100%')
          .height('100%')
          .padding({ top: 2, bottom: 96 })
        }
        .onRefreshing(() => {
          this.refreshList()
        })
        .width('100%')
        .height('100%')

        if (this.appState.sessions.length === 0) {
          if (this.appState.sessionsLoading) {
            // 首拉骨架屏：灰色块还原条目布局 + 透明度闪烁（官方 skeletondiagram 案例）
            Column() {
              SkeletonList({ rows: 6 })
            }
            .width('100%')
            .height('100%')
            .justifyContent(FlexAlign.Center)
          } else {
            // 自绘空态（对齐 FilesPage 空目录样式），替代原 IBestEmpty
            Column({ space: 8 }) {
              Text(this.emptyText())
                .fontSize(14)
                .fontColor(Design.TEXT_SUB(this.uiDark))
                .textAlign(TextAlign.Center)
            }
            .width('100%')
            .height('100%')
            .justifyContent(FlexAlign.Center)
          }
        }
      }
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.pageBg())
    // 居中弹窗（SheetType.CENTER）：与平板端新建文件夹弹窗同一交互语言；
    // 居中弹窗官方最小高度 320vp，380 是内容（工作区列表 220 + 按钮）的舒适值
    .bindSheet($$this.showNewSheet, this.newSessionSheet(), {
      height: 380,
      preferType: SheetType.CENTER,
      showClose: true,
      title: { title: I18n.t('新建会话', 'New session') },
      backgroundColor: Design.SURFACE(this.uiDark),
      dragBar: false,
      // 下滑关闭带弹性回弹（未注册时官方无回弹行为）
      onWillSpringBackWhenDismiss: sheetSpringBack
    })
  }

  /** 工作区分组：分组头 + （展开时）组内会话卡片；收放带展开/收起动画 */
  @Builder
  groupSection(g: WorkspaceGroup) {
    Column({ space: 8 }) {
      // 分组头：箭头随收放旋转
      Row({ space: 8 }) {
        Text('▸')
          .fontSize(13)
          .fontColor(Design.TEXT_HINT(this.uiDark))
          .width(16)
          .rotate({ angle: this.isCollapsed(g) ? 0 : 90 })
          .animation({ curve: Design.motionCurve })
        Text(g.name)
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor(Design.TEXT_MAIN(this.uiDark))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Text(g.sessions.length.toString() + I18n.t(' 个会话', ' sessions'))
          .fontSize(11)
          .fontColor(Design.TEXT_HINT(this.uiDark))
        // 组内运行中数量角标
        if (g.sessions.some((s: SessionView) => s.running)) {
          Circle({ width: 8, height: 8 }).fill(Design.SUCCESS)
        }
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 12, bottom: 12 })
      // 分组块背板：SURFACE_SUB 底 + 1.5vp 描边（对齐平板侧栏工作区块），
      // 与组内会话卡片（SURFACE + 投影）形成容器/内容两层
      .backgroundColor(Design.SURFACE_SUB(this.uiDark))
      .borderRadius(Design.RADIUS_CARD)
      .border({
        width: 1.5,
        color: this.uiDark ? '#40FFFFFF' : '#33000000'
      })
      .onClick(() => {
        this.toggleGroup(g)
      })

      // 展开的组：显示会话卡片（插入/删除由 animateTo + transition 驱动）
      if (!this.isCollapsed(g)) {
        ForEach(g.sessions, (item: SessionView) => {
          this.sessionCard(item)
        }, (item: SessionView) => item.sessionId)
      }
    }
    .width('100%')
  }

  /** 新建会话底部弹层：工作区选择 + 创建按钮 */
  @Builder
  newSessionSheet() {
    Column({ space: 12 }) {
      if (this.appState.workspaces.length === 0) {
        Text(I18n.t('未获取到工作区列表，将按默认方式创建', 'No workspace list; creating with defaults'))
          .fontSize(12)
          .fontColor(Design.TEXT_HINT(this.uiDark))
          .width('100%')
      } else {
        List({ space: 6 }) {
          ForEach(this.appState.workspaces, (w: WorkspaceInfo) => {
            ListItem() {
              Row({ space: 8 }) {
                // 选中态：单选圈由描边宽度区分，避免额外图标资源
                Column()
                  .width(16)
                  .height(16)
                  .borderRadius(Design.RADIUS_PILL)
                  .borderWidth(this.selectedWorkspaceId === w.workspaceId ? 5 : 1)
                  .borderColor(this.selectedWorkspaceId === w.workspaceId ? this.accent() : Design.TEXT_HINT(this.uiDark))
                  .animation({ curve: Design.pressCurve })
                Column({ space: 2 }) {
                  Text(w.displayName())
                    .fontSize(14)
                    .fontWeight(FontWeight.Medium)
                    .fontColor(Design.TEXT_MAIN(this.uiDark))
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                  if (w.path.length > 0 && w.path !== w.displayName()) {
                    Text(w.path)
                      .fontSize(11)
                      .fontColor(Design.TEXT_HINT(this.uiDark))
                      .maxLines(1)
                      .textOverflow({ overflow: TextOverflow.Ellipsis })
                  }
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)
              }
              .width('100%')
              .padding(12)
              .borderRadius(Design.RADIUS_CONTROL)
              .backgroundColor(this.selectedWorkspaceId === w.workspaceId ? Design.selectedBg(this.accent()) : Design.FILL_LIGHT(this.uiDark))
              .animation({ curve: Design.pressCurve })
              .onClick(() => {
                // 再次点击已选项取消指定，回退默认创建
                this.selectedWorkspaceId = this.selectedWorkspaceId === w.workspaceId ? '' : w.workspaceId
              })
            }
          }, (w: WorkspaceInfo) => w.workspaceId)
        }
        .width('100%')
        .height(220)
        .edgeEffect(EdgeEffect.Spring)
      }

      if (this.createNote.length > 0) {
        Text(this.createNote)
          .fontSize(12)
          .fontColor(Design.DANGER)
          .width('100%')
      }

      Button(this.creating ? I18n.t('创建中…', 'Creating…') : I18n.t('创建会话', 'Create session'))
        .fontSize(15)
        .height(44)
        .width('100%')
        .backgroundColor(this.accent())
        .borderRadius(Design.RADIUS_CONTROL)
        .enabled(!this.creating)
        .onClick(() => {
          this.createAndEnter()
        })
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 8, bottom: 16 })
  }

  private emptyText(): string {
    const srv = this.appState.server
    if (!srv) {
      return I18n.t('请先在设置中配置服务器', 'Configure a server in Settings first')
    }
    const err = this.appState.lastError
    const url = srv.normalizedUrl()
    if (err.length > 0) {
      return err + '\n' + url + '\n' + I18n.t('下拉重试', 'Pull down to retry')
    }
    return I18n.t('下拉刷新或新建会话', 'Pull to refresh or create a session') + '\n' + url
  }

  /**
   * 视图切换胶囊。高亮通过 getActive 闭包读取（@Builder 按值传参不建立
   * 渲染依赖，直接传值会导致切换后高亮不动）；点击显式设置目标视图
   * （onTargetView 返回该胶囊代表的视图状态，避免 toggle 语义让"全部"变空操作）。
   */
  @Builder
  viewChip(label: string, getActive: () => boolean, onTargetView: () => boolean) {
    Text(label)
      .fontSize(13)
      .padding({ left: 12, right: 12, top: 5, bottom: 5 })
      .fontColor(getActive() ? Color.White : Design.TEXT_SUB(this.uiDark))
      .backgroundColor(getActive() ? this.accent() : Design.SURFACE_SUB(this.uiDark))
      .borderRadius(Design.RADIUS_PILL)
      .animation({ curve: Design.pressCurve })
      .onClick(() => {
        this.archivedView = onTargetView()
      })
  }

  @Builder
  sessionCard(item: SessionView) {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Text(item.displayLabel())
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .fontColor(Design.TEXT_MAIN(this.uiDark))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        // 胶囊状态标签（运行中带呼吸点）
        Row({ space: 4 }) {
          if (item.running) {
            Circle({ width: 6, height: 6 }).fill(Design.SUCCESS)
          }
          Text(item.statusLabel())
            .fontSize(11)
            .fontColor(this.statusColor(item))
        }
        .padding({ left: 8, right: 8, top: 3, bottom: 3 })
        .borderRadius(Design.RADIUS_PILL)
        .backgroundColor(item.running ? Design.successBg() : Design.FILL_LIGHT(this.uiDark))
      }.width('100%')

      Row() {
        Text(item.updatedLabel())
          .fontSize(12)
          .fontColor(Design.TEXT_HINT(this.uiDark))
      }.width('100%')
    }
    .width('100%')
    .padding(Design.PAD_CARD)
    .backgroundColor(this.cardBg())
    .borderRadius(Design.RADIUS_CARD)
    .shadow(Design.cardShadow(this.uiDark))
    // 收放动画：展开时淡入并自上方 14vp 滑入，收起时淡出
    .transition(TransitionEffect.OPACITY.combine(TransitionEffect.translate({ y: -14 })))
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
    // 长按弹出会话操作菜单（归档/取消归档）；对齐平板侧栏同款
    // outlineWidth(0)：去掉系统背板默认描边（真机黑框）
    .bindContextMenu(sessionMenu(this.menuParams(item)), ResponseType.LongPress, {
      outlineWidth: 0,
      borderRadius: Design.RADIUS_CONTROL,
      backgroundColor: Design.SURFACE(this.uiDark),
      backgroundBlurStyle: BlurStyle.NONE
    })
    .onClick(() => {
      const p = new NavParams()
      p.sessionId = item.sessionId
      AppNav.push(AppNav.R_CHAT, p)
    })
  }

  /** 长按菜单参数（共享 Builder sessionMenu 消费；见 components/SessionContextMenu） */
  private menuParams(item: SessionView): SessionMenuParams {
    const p = new SessionMenuParams()
    p.item = item
    p.dark = this.uiDark
    p.archived = this.appState.archivedSessionIds.indexOf(item.sessionId) >= 0
    p.onArchive = (): void => {
      this.confirmArchive(item)
    }
    p.onUnarchive = (): void => {
      this.appState.unarchiveSession(item.sessionId)
    }
    return p
  }

  /** 长按菜单已抽为共享 Builder sessionMenu（components/），两端共用 */

  /** 删除会话：二次确认（不可恢复）。共享弹窗见 SessionActions；当前菜单已隐藏该入口 */
  private confirmDelete(item: SessionView): void {
    SessionActions.confirmDelete(item, () => {
      this.appState.deleteSession(item.sessionId)
    })
  }
}
