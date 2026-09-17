import { common } from '@kit.AbilityKit'
import { window } from '@kit.ArkUI'
import { AppState } from '../services/AppState'
import { I18n } from '../common/I18n'
import { Theme, Design } from '../models/Theme'
import { HomePage } from './HomePage'
import { SessionsPage } from './SessionsPage'
import { FilesPage } from './FilesPage'
import { StatsPage } from './StatsPage'
import { SettingsPage } from './SettingsPage'

/**
 * 主界面：底部五个 Tab（主页 / 会话 / 文件 / 统计 / 设置）。
 *
 * 鸿蒙化要点：
 * - 全屏沉浸布局（EntryAbility 设置），安全区由页面自行避让
 * - 底部导航为悬浮胶囊：与边缘留出间距、大圆角、轻投影，
 *   悬浮于内容之上；内容区延伸到胶囊后方（clip 内容可见）
 * - 选中图标放大动效，贴近系统 Tab 切换手感
 * - @StorageLink('uiDark') 绑定深浅判定：深色模式切换时整页（含胶囊）重建
 */
@Entry
@Component
struct Index {
  @StorageLink('appState') appState: AppState = AppState.instance
  /** 深浅判定（AppState.syncThemeStorage 写入）；变更驱动整页刷新 */
  @StorageLink('uiDark') @Watch('onUiDarkChange') uiDark: boolean = false
  /** 当前主题 id 原语（AppState 写入）；主题切换驱动整页刷新 */
  @StorageLink('uiTheme') uiTheme: string = 'deep-space'
  @State currentTab: number = 0
  /** 手势指示条安全区高度（vp），EntryAbility 首帧前已写入 */
  @State bottomSafe: number = Design.safeBottom()

  /** 应用内深浅切换时同步状态栏内容色与窗口底色（无需离开页面） */
  onUiDarkChange(): void {
    this.syncBarStyle()
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
   * 系统返回（返回键/侧滑手势）：文件页先关预览面板、再退回上级目录；
   * 不在主页 Tab 先回主页；最后一级才走系统默认（退出应用）。
   * 文件页路径快照由 FilesPage 写入 AppStorage（filesPath/filesPathHasParent）。
   */
  onBackPress(): boolean {
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
      .animation({ duration: Design.ANIM_DURATION, curve: Curve.Friction })
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
        .animation({
          duration: Design.PRESS_DURATION,
          curve: Curve.Smooth
        })
      Text(title)
        .fontSize(10)
        .fontColor(this.currentTab === index ? this.accent() : this.inactiveColor())
        .fontWeight(this.currentTab === index ? FontWeight.Medium : FontWeight.Normal)
    }
    .layoutWeight(1)
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .animation({ duration: Design.PRESS_DURATION, curve: Curve.Smooth })
    .onClick(() => {
      this.currentTab = index
    })
  }
}
