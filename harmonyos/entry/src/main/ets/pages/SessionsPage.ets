import { router } from '@kit.ArkUI'
import { IBestEmpty } from '@ibestservices/ibest-ui-v2'
import { Theme, Design } from '../models/Theme'
import { AppState } from '../services/AppState'
import { SessionView } from '../models/SessionView'
import { WorkspaceInfo } from '../models/WorkspaceInfo'
import { I18n } from '../common/I18n'

/** 工作区分组：cwd → 组名 + 组内会话（按更新时间倒序） */
class WorkspaceGroup {
  /** 分组 key（完整 cwd，去尾分隔符） */
  key: string = ''
  /** 显示名：路径末段 */
  name: string = ''
  sessions: SessionView[] = []

  static build(sessions: SessionView[]): WorkspaceGroup[] {
    const order: string[] = []
    const map: Map<string, WorkspaceGroup> = new Map()
    for (const s of sessions) {
      const key = WorkspaceGroup.keyOf(s)
      let g = map.get(key)
      if (!g) {
        g = new WorkspaceGroup()
        g.key = key
        g.name = WorkspaceGroup.nameOf(s)
        map.set(key, g)
        order.push(key)
      }
      g.sessions.push(s)
    }
    const out: WorkspaceGroup[] = []
    for (const k of order) {
      const g = map.get(k)
      if (g) {
        // 组内按更新时间倒序
        g.sessions.sort((a: SessionView, b: SessionView) => b.updatedAt - a.updatedAt)
        out.push(g)
      }
    }
    return out
  }

  /** 分组 key：cwd 去尾分隔符；空 cwd 归入未分组 */
  private static keyOf(s: SessionView): string {
    const raw = s.cwd.trim()
    if (raw.length === 0) {
      return ''
    }
    return raw.replace(/[\\/]+$/, '')
  }

  /** 组名：cwd 末段；未分组返回固定文案 */
  private static nameOf(s: SessionView): string {
    const key = WorkspaceGroup.keyOf(s)
    if (key.length === 0) {
      return I18n.t('未指定工作区', 'No workspace')
    }
    const parts = key.split(/[\\/]/)
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].length > 0) {
        return parts[i]
      }
    }
    return key
  }
}

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
  /** 收起的分组 key 集合（默认全部展开；有运行中会话的组刷新后强制展开） */
  @State collapsedKeys: string[] = []
  /** 列表视图：false 全部会话（隐藏已归档）/ true 已归档 */
  @State archivedView: boolean = false

  aboutToAppear(): void {
    this.appState.refreshSessions()
    this.appState.refreshWorkspaces()
  }

  private refreshList(): void {
    this.refreshing = true
    this.appState.refreshSessions().then(() => {
      this.appState.refreshWorkspaces().then(() => {
        this.refreshing = false
      })
    })
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
      router.pushUrl({ url: 'pages/ChatPage', params: { sessionId: sessionId } })
        .catch(() => {
        })
    })
  }

  /** 分组数据：按视图过滤（默认视图隐藏已归档；归档视图只显示已归档） */
  private groups(): WorkspaceGroup[] {
    const archived = new Set<string>(this.appState.archivedSessionIds)
    const visible = this.appState.sessions.filter((s: SessionView) => archived.has(s.sessionId) === this.archivedView)
    return WorkspaceGroup.build(visible)
  }

  /** 归档会话：确认后 workspace.archiveSession（与 Web 端 sc-archive-btn 一致） */
  private confirmArchive(item: SessionView): void {
    AlertDialog.show({
      title: I18n.t('归档会话', 'Archive session'),
      message: I18n.t('归档「' + item.displayLabel() + '」？归档后从会话列表移除，可在"已归档"视图查看。', 'Archive ' + item.displayLabel() + '? It will leave the list; view it under Archived.'),
      primaryButton: { value: I18n.t('取消', 'Cancel'), action: () => { } },
      secondaryButton: {
        value: I18n.t('归档', 'Archive'),
        action: () => {
          this.appState.archiveSession(item.sessionId)
        }
      }
    })
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
    // animateTo 包裹状态变更：本次变化涉及的插入/删除走 transition 动画
    this.getUIContext().animateTo({
      duration: 280,
      curve: Curve.Friction,
      onFinish: () => {
      }
    }, () => {
      if (collapsing) {
        this.collapsedKeys = [...this.collapsedKeys, g.key]
      } else {
        this.collapsedKeys = this.collapsedKeys.filter((k: string) => k !== g.key)
      }
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

  /** 状态标签颜色：运行中 / 空白 / 空闲 */
  private statusColor(item: SessionView): string {
    if (item.running) {
      return Design.SUCCESS
    }
    if (item.blank) {
      return Design.WARNING
    }
    return Design.TEXT_HINT(this.uiDark)
  }

  build() {
    Column() {
      Row() {
        Text(I18n.t('会话', 'Sessions'))
          .fontSize(24)
          .fontWeight(FontWeight.Bold)
          .fontColor(Design.TEXT_MAIN(this.uiDark))
        Blank()
        Button(I18n.t('＋ 新建', '+ New'))
          .fontSize(14)
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
          IBestEmpty({
            description: this.emptyText(),
            emptyImage: 'default'
          })
            .width('100%')
            .height('100%')
        }
      }
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.pageBg())
    .bindSheet($$this.showNewSheet, this.newSessionSheet(), {
      height: 380,
      showClose: true,
      title: { title: I18n.t('新建会话', 'New session') },
      backgroundColor: Design.SURFACE(this.uiDark)
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
          .animation({ duration: 280, curve: Curve.Friction })
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
      .backgroundColor(this.cardBg())
      .borderRadius(Design.RADIUS_CARD)
      .shadow(Design.cardShadow(this.uiDark))
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
                  .animation({ duration: Design.PRESS_DURATION, curve: Curve.Smooth })
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
              .animation({ duration: Design.PRESS_DURATION, curve: Curve.Smooth })
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
      .animation({ duration: Design.PRESS_DURATION, curve: Curve.Smooth })
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
    .animation({ duration: Design.PRESS_DURATION, curve: Curve.Smooth })
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.pressedId = item.sessionId
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.pressedId = ''
      }
    })
    // 长按归档（对齐 Web 端会话卡的归档按钮；仅非归档视图提供）
    .gesture(LongPressGesture({ repeat: false, duration: 500 })
      .onAction(() => {
        if (!this.archivedView) {
          this.confirmArchive(item)
        }
      }))
    .onClick(() => {
      router.pushUrl({ url: 'pages/ChatPage', params: { sessionId: item.sessionId } })
        .catch(() => {
        })
    })
  }
}
