import { AppNav } from '../../common/AppNav'
import { PageTransitions, DrawerState } from '../../common/PageTransitions'
import { Theme, Design } from '../../models/Theme'
import { ChatView } from '../ChatView'
import { HomePage } from '../HomePage'
import { FilesPage } from '../FilesPage'
import { StatsPage } from '../StatsPage'
import { SettingsPage } from '../SettingsPage'
import { AnnouncementsPageView } from '../AnnouncementsPage'
import { FeedbackPageView } from '../FeedbackPage'
import { AsrTestPageView } from '../AsrTestPage'
import { PluginCenterPageView } from '../PluginCenterPage'
import { ServerSettingsPageView } from '../ServerSettingsPage'
import { TabletSidebar } from './TabletSidebar'
import { SplitEmpty } from './SplitEmpty'
import { I18n } from '../../common/I18n'

/**
 * 平板分栏根（≥600vp）：Navigation NavigationMode.Split，
 * navBar = 侧栏（会话列表 + 底部导航），内容区 = 栈顶 NavDestination。
 * 布局跟随桌面端 WebUI（ds-sidebar + ds-content）。
 *
 * 依据：
 * - developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-navigation-split-mode
 *   （mode/navBarWidth/navBarWidthRange/minContentWidth/splitPlaceholder）
 * - developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-basic-components-navigation
 *
 * 栈约定（经 AppNav 分发）：
 * - 主视图（tabletHome/tabletFiles/tabletStats/tabletSettings）空栈 push、
 *   非空 replacePathByName，栈内同时只有一个主视图；
 * - 子页面（公告/反馈/ASR/服务器管理）push 叠加，返回逐层 pop；
 * - 会话详情（ChatPage 名下复用 ChatView）也是 replace 语义的主视图。
 */
@Component
export struct TabletIndex {
  @StorageLink('uiDark') uiDark: boolean = false
  @StorageLink('uiTheme') uiTheme: string = 'deep-space'
  /** 侧栏 nav 高亮；右栏为主视图时同步，进入会话/子页清空 */
  @StorageLink('tabletNav') tabletNav: string = ''
  private stack: NavPathStack = new NavPathStack()
  /** 子页抽屉转场位移（PageTransitions 代理经 animateTo 驱动） */
  drawerState: DrawerState = new DrawerState()

  aboutToAppear(): void {
    AppNav.tabletStack = this.stack
  }

  aboutToDisappear(): void {
    AppNav.tabletStack = null
  }

  /** 右栏当前主视图名（无栈内容时为 ''），侧栏高亮据此兜底 */
  private pageBg(): string {
    return Theme.bgOf(Theme.get(this.uiTheme), this.uiDark)
  }

  /** navDestination builder：路由名 → NavDestination（子组件内嵌，不经过 router） */
  @Builder
  pageMap(name: string) {
    if (name === AppNav.R_CHAT) {
      // sessionId 读 AppStorage('tabletChatSession')（AppNav.openChat 在 push 前写入）；
      // 栈 param 反查在 builder 构建时机查不到值，曾导致点会话不加载消息
      NavDestination() {
        ChatView({ sessionId: AppStorage.get<string>('tabletChatSession') ?? '' })
          .width('100%')
          .height('100%')
      }
      .hideTitleBar(true)
      .onBackPressed(() => {
        // ChatView 覆盖层自行消费；未消费时回到空栈（回侧栏占位）
        return false
      })

    } else if (name === AppNav.R_HOME) {
      NavDestination() {
        HomePage()
      }
      .hideTitleBar(true)

    } else if (name === AppNav.R_FILES) {
      NavDestination() {
        FilesPage()
      }
      .hideTitleBar(true)

    } else if (name === AppNav.R_STATS) {
      NavDestination() {
        StatsPage()
      }
      .hideTitleBar(true)

    } else if (name === AppNav.R_SETTINGS) {
      NavDestination() {
        SettingsPage()
      }
      .hideTitleBar(true)

    } else if (name === AppNav.R_ANNOUNCEMENTS) {
      NavDestination() {
        AnnouncementsPageView()
      }
      .hideTitleBar(true)
      .onReady((context: NavDestinationContext) => {
        PageTransitions.attach(context, this.drawerState)
      })
      .onDisAppear(() => {
        // detach 需要 context；onDisAppear 无参，onReady 时已存到 state 上
        PageTransitions.detachById(this.drawerState)
      })
      .translate({ x: this.drawerState.x })

    } else if (name === AppNav.R_FEEDBACK) {
      NavDestination() {
        FeedbackPageView()
      }
      .hideTitleBar(true)
      .onReady((context: NavDestinationContext) => {
        PageTransitions.attach(context, this.drawerState)
      })
      .onDisAppear(() => {
        PageTransitions.detachById(this.drawerState)
      })
      .translate({ x: this.drawerState.x })

    } else if (name === AppNav.R_ASR) {
      NavDestination() {
        AsrTestPageView()
      }
      .hideTitleBar(true)
      .onReady((context: NavDestinationContext) => {
        PageTransitions.attach(context, this.drawerState)
      })
      .onDisAppear(() => {
        PageTransitions.detachById(this.drawerState)
      })
      .translate({ x: this.drawerState.x })

    } else if (name === AppNav.R_PLUGIN_CENTER) {
      NavDestination() {
        PluginCenterPageView()
      }
      .hideTitleBar(true)
      .onReady((context: NavDestinationContext) => {
        PageTransitions.attach(context, this.drawerState)
      })
      .onDisAppear(() => {
        PageTransitions.detachById(this.drawerState)
      })
      .translate({ x: this.drawerState.x })

    } else if (name === AppNav.R_SERVERS) {
      NavDestination() {
        ServerSettingsPageView()
      }
      .hideTitleBar(true)
      .onReady((context: NavDestinationContext) => {
        PageTransitions.attach(context, this.drawerState)
      })
      .onDisAppear(() => {
        PageTransitions.detachById(this.drawerState)
      })
      .translate({ x: this.drawerState.x })
    }
  }
  build() {
    Navigation(this.stack) {
      TabletSidebar()
    }
    .mode(NavigationMode.Split)
    .navBarWidth(300)
    .navBarWidthRange([240, 360])
    .minContentWidth(400)
    .hideTitleBar(true)
    .hideToolBar(true)
    .navDestination(this.pageMap)
    // 抽屉式子页转场：NavBar 参与（index -1）或 Replace 时代理返回 undefined → 系统默认
    .customNavContentTransition(PageTransitions.navDelegate(this.getUIContext()))
    .backgroundColor(this.pageBg())
  }
}