import { display, mediaquery } from '@kit.ArkUI'

/**
 * 宽屏断点原语：写入 AppStorage('uiWide')，Index 按它在「手机 Tabs 布局」与
 * 「平板 Navigation 分栏布局」之间切换根容器。
 *
 * 阈值取 600vp：与官方一多 md 断点、以及 NavigationMode.Auto 的单双栏切换
 * 阈值一致（minNavBarWidth 240vp + minContentWidth 360vp，见
 * developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-basic-components-navigation
 * 的 minContentWidth / NavigationMode.Auto 说明）。
 * 媒体查询宽度特征支持 vp 单位（见
 * developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-layout-development-media-query）。
 *
 * 注册时机注意：几何类媒体特征（宽度）在窗口完成布局前求值为 false，
 * 且挂在 loadContent 之前 UIContext 上的监听收不到后续 change 事件——
 * 因此除 EntryAbility 早期注册外，Index.aboutToAppear 必须用页面自身的
 * UIContext 重新注册（watch 幂等，先 off 旧监听）。
 */
export class Breakpoint {
  /** 官方 md 断点 / NavigationMode.Auto 默认分栏阈值（vp） */
  static readonly WIDE_VP: number = 600

  /** 查询条件（宽度 ≥ 600vp） */
  private static readonly QUERY: string = '(min-width: 600vp)'

  /** 已注册的监听（重复 watch 时先解绑，避免双重回调） */
  private static listener: mediaquery.MediaQueryListener | null = null

  /**
   * 注册宽屏断点监听；注册即同步一次初值；可重复调用（幂等）。
   * 另以 display 默认屏宽度（物理 px / 密度 ≈ vp）兜底求值：媒体查询在
   * 部分机型上注册后初值滞后，宽度是启动时已知的几何事实，直接计算。
   */
  static watch(ui: UIContext): void {
    if (Breakpoint.listener !== null) {
      try {
        Breakpoint.listener.off('change')
      } catch (e) {
        // 旧监听所属 UIContext 可能已失效，忽略解绑异常
      }
      Breakpoint.listener = null
    }
    const l: mediaquery.MediaQueryListener = ui.getMediaQuery().matchMediaSync(Breakpoint.QUERY)
    l.on('change', (result: mediaquery.MediaQueryResult) => {
      AppStorage.setOrCreate('uiWide', result.matches === true)
    })
    Breakpoint.listener = l

    let wide = l.matches === true
    try {
      const d = display.getDefaultDisplaySync()
      const density = d.densityPixels > 0 ? d.densityPixels : 3.5
      const widthVp = d.width / density
      wide = wide || widthVp >= Breakpoint.WIDE_VP
    } catch (e) {
      // display 不可用时退回媒体查询结果
    }
    AppStorage.setOrCreate('uiWide', wide)
  }

  /** 当前是否宽屏布局（读原语，不建渲染依赖；组件内请用 @StorageLink('uiWide')） */
  static isWide(): boolean {
    return AppStorage.get<boolean>('uiWide') === true
  }
}
