import { common } from '@kit.AbilityKit'
import { window } from '@kit.ArkUI'
import { AppState } from '../services/AppState'
import { Breakpoint } from '../common/Breakpoint'
import { SystemDarkWatch } from '../common/SystemDarkWatch'
import { AppColorMode } from '../common/AppColorMode'
import { AppNav } from '../common/AppNav'
import { I18n } from '../common/I18n'
import { Theme, Design } from '../models/Theme'
import { HomePage } from './HomePage'
import { SessionsPage } from './SessionsPage'
import { FilesPage } from './FilesPage'
import { StatsPage } from './StatsPage'
import { SettingsPage } from './SettingsPage'
import { TabletIndex } from './tablet/TabletIndex'

/**
 * 主界面：按宽屏断点双形态。
 *
 * - 手机（uiWide=false，<600vp）：底部五个悬浮胶囊 Tab（主页/会话/文件/统计/设置），
 *   原形态零改动。
 * - 平板（uiWide=true，≥600vp）：TabletIndex 的 Navigation 分栏布局
 *   （左侧栏 + 右内容区，跟随桌面端 WebUI 骨架）。
 *
 * 鸿蒙化要点：
 * - 全屏沉浸布局（EntryAbility 设置），安全区由页面自行避让
 * - 底部导航为悬浮胶囊：与边缘留出间距、大圆角、轻投影，
 *   悬浮于内容之上；内容区延伸到胶囊后方（clip 内容可见）
 * - 选中图标放大动效，贴近系统 Tab 切换手感
 * - @StorageLink('uiDark') 绑定深浅判定：深色模式切换时整页（含胶囊）重建
 * - uiWide 由 Breakpoint.watch（EntryAbility 注册）写入，窗口拖拽/分屏实时切换
 */
@Entry
@Component
struct Index {
  @StorageLink('appState') appState: AppState = AppState.instance
  /** 深浅判定（AppState 写入）；变更驱动整页刷新 */
  @StorageLink('uiDark') @Watch('onUiDarkChange') uiDark: boolean = false
  /** 当前主题 id 原语（AppState 写入）；主题切换驱动整页刷新 */
  @StorageLink('uiTheme') uiTheme: string = 'deep-space'
  /** 宽屏断点（Breakpoint.watch 写入）：true 走平板分栏，false 走手机 Tabs */
  @StorageLink('uiWide') @Watch('onUiWideChange') uiWide: boolean = false
  @State currentTab: number = 0
  /** 手势指示条安全区高度（vp），EntryAbility 首帧前已写入 */
  @State bottomSafe: number = Design.safeBottom()

  /** 应用内深浅切换时同步 colorMode、状态栏内容色与窗口底色（无需离开页面） */
  onUiDarkChange(): void {
    // 应用级 colorMode 跟随 App 内设置：未显式设色的默认资源（文字/输入框）
    // 否则跟随系统深浅，系统深色 + App 浅色主题时出现白底白字
    try {
      AppColorMode.apply(getContext(this) as common.UIAbilityContext)
    } catch (e) {
      // 忽略：个别上下文不可用时，下次冷启动由 EntryAbility 兜底
    }
    this.syncBarStyle()
  }

  /** 断点翻转（平板旋转/分屏/2in1 拖窗）时收窄手机 Tab 状态，避免回来时停在旧 Tab */
  onUiWideChange(): void {
    if (!this.uiWide) {
      // 平板右栏栈由 TabletIndex 卸载自动失效（aboutToDisappear 置空）
      this.currentTab = 0
    }
  }

  aboutToAppear(): void {
    // 几何类媒体特征在窗口布局完成前求值恒为 false，EntryAbility 早期注册的
    // 初值不可靠；这里用页面自身 UIContext 重注册（watch 幂等），并立即
    // 以当前窗口宽度兜底求值一次。
    Breakpoint.watch(this.getUIContext())
    // 系统深浅 change 事件同样必须由页面 UIContext 注册才能收到
    // （loadContent 前 UIContext 上的监听收不到后续事件）：EntryAbility
    // 早期注册只保证首帧初值，这里重注册接管运行期系统切换。
    SystemDarkWatch.watch(this.getUIContext())
  }

  private pageBg(): string {
    return Theme.bgOf(Theme.get(this.uiTheme), this.uiDark)
  }

  private accent(): string {
    return Theme.accentOf(Theme.get(this.uiTheme), this.uiDark)
  }

  private inactiveColor(): string {
    return Design.TEXT_HINT(this.uiDark)
  }

  onPageShow(): void {
    this.bottomSafe = Design.safeBottom()
    // 状态栏内容色/窗口底色随应用内深浅设置（EntryAbility 只处理系统级切换）
    this.syncBarStyle()
  }

  /**
   * 系统返回（返回键/侧滑手势）：
   * - 平板形态：宽屏下 TabletIndex 的 NavDestination 自带返回处理
   *   （onBackPressed），栈空时若侧栏主视图是文件页，先关预览、再退
   *   上级目录（tabletNav==='tabletFiles' 判定），最后放行。
   * - 手机形态：文件页先关预览面板、再退回上级目录；
   *   不在主页 Tab 先回主页；最后一级才走系统默认（退出应用）。
   *   文件页路径快照由 FilesPage 写入 AppStorage（filesPath/filesPathHasParent）。
   */
  onBackPress(): boolean {
    if (this.uiWide) {
      // 平板：栈顶 NavDestination 的 onBackPressed 先触发（系统分发顺序）；
      // 走到这里说明栈空（右栏占位态）——但侧栏主视图若是文件页，
      // 系统侧滑/返回键应先关预览、再退目录上级，最后才放行退出。
      // tabletNav 在进会话等场景会被置空，恰好可判定文件页是否在前台。
      if (AppStorage.get<string>('tabletNav') === 'tabletFiles') {
        if (AppStorage.get<boolean>('filesPreviewVisible') === true) {
          AppStorage.setOrCreate('filesPreviewVisible', false)
          return true
        }
        if (AppStorage.get<boolean>('filesPathHasParent') === true) {
          const seq = AppStorage.get<number>('filesNavUpSeq') ?? 0
          AppStorage.setOrCreate('filesNavUpSeq', seq + 1)
          return true
        }
      }
      return false
    }
    if (this.currentTab === 2) {
      if (AppStorage.get<boolean>('filesPreviewVisible') === true) {
        AppStorage.setOrCreate('filesPreviewVisible', false)
        return true
      }
      if (AppStorage.get<boolean>('filesPathHasParent') === true) {
        const seq = AppStorage.get<number>('filesNavUpSeq') ?? 0
        AppStorage.setOrCreate('filesNavUpSeq', seq + 1)
        return true
      }
    }
    if (this.currentTab !== 0) {
      this.currentTab = 0
      return true
    }
    return false
  }

  private syncBarStyle(): void {
    try {
      const ctx = getContext(this) as common.UIAbilityContext
      window.getLastWindow(ctx)
        .then((win: window.Window) => {
          win.setWindowSystemBarProperties({
            statusBarContentColor: this.uiDark ? '#F2F3F5' : '#1F2937'
          })
          win.setWindowBackgroundColor(this.pageBg())
        })
    } catch (e) {
      // 忽略：个别窗口场景取不到 LastWindow
    }
  }

  build() {
    if (this.uiWide) {
      TabletIndex()
    } else {
      this.phoneLayout()
    }
  }

  /** 手机形态：Tabs + 悬浮胶囊导航（原实现，零行为改动） */
  @Builder
  phoneLayout() {
    Stack({ alignContent: Alignment.Bottom }) {
      // 内容层：Tab 内容占满全屏，底部由各页面自身的列表底部留白兜底
      Tabs({ barPosition: BarPosition.End, index: this.currentTab }) {
        TabContent() {
          HomePage()
        }

        TabContent() {
          SessionsPage()
        }

        TabContent() {
          FilesPage()
        }

        TabContent() {
          StatsPage()
        }

        TabContent() {
          SettingsPage()
        }
      }
      .scrollable(false)
      .barHeight(0)
      .animation({ curve: Design.motionCurve })
      .onChange((index: number) => {
        this.currentTab = index
        // TabContent 的 aboutToAppear 只在首次显示时触发，
        // 切回主页/会话页时主动刷新，避免看到过期数据。
        if (index === 0) {
          this.appState.refreshHealth()
          this.appState.refreshStats()
          this.appState.refreshSessions()
        } else if (index === 1) {
          this.appState.refreshSessions()
        } else if (index === 3) {
          this.appState.refreshStats()
        }
      })

      // 悬浮胶囊导航
      Row({ space: 2 }) {
        this.capsuleItem(I18n.t('主页', 'Home'), $r('app.media.ic_home'), $r('app.media.ic_home_filled'), 0)
        this.capsuleItem(I18n.t('会话', 'Sessions'), $r('app.media.ic_message'), $r('app.media.ic_message_filled'), 1)
        this.capsuleItem(I18n.t('文件', 'Files'), $r('app.media.ic_folder'), $r('app.media.ic_folder_filled'), 2)
        this.capsuleItem(I18n.t('统计', 'Stats'), $r('app.media.ic_stats'), $r('app.media.ic_stats_filled'), 3)
        this.capsuleItem(I18n.t('设置', 'Settings'), $r('app.media.ic_settings'), $r('app.media.ic_settings'), 4)
      }
      .width('auto')
      .height(62)
      .margin({
        left: 24,
        right: 24,
        bottom: this.bottomSafe > 0 ? this.bottomSafe + 8 : 16
      })
      .padding({ left: 6, right: 6 })
      .backgroundColor(Design.capsuleBg(this.uiDark))
      .borderRadius(Design.RADIUS_PILL)
      .border({ width: 0.5, color: Design.borderHair(this.uiDark) })
      .shadow({
        radius: 24,
        color: this.uiDark ? '#80000000' : '#26000000',
        offsetX: 0,
        offsetY: 6
      })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.pageBg())
  }

  @Builder
  capsuleItem(title: string, icon: Resource, activeIcon: Resource, index: number) {
    Column({ space: 3 }) {
      Image(this.currentTab === index ? activeIcon : icon)
        .width(this.currentTab === index ? 24 : 22)
        .height(this.currentTab === index ? 24 : 22)
        .fillColor(this.currentTab === index ? this.accent() : this.inactiveColor())
        .objectFit(ImageFit.Contain)
        .animation({ curve: Design.pressCurve })
      Text(title)
        .fontSize(10)
        .fontColor(this.currentTab === index ? this.accent() : this.inactiveColor())
        .fontWeight(this.currentTab === index ? FontWeight.Medium : FontWeight.Normal)
    }
    .layoutWeight(1)
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .animation({ curve: Design.pressCurve })
    .onClick(() => {
      this.currentTab = index
    })
  }
}
