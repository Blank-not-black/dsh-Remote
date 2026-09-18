/**
 * 主题色板（对应 Web 端四套配色：深空/落日/易北爱乐厅/草原孤塔）。
 *
 * 除颜色外，收敛了一套鸿蒙设计令牌（HarmonyOS Design 常用值）：
 * - 卡片大圆角 16vp、控件 12vp、胶囊 full
 * - 卡片轻投影（低透明度大模糊 + 低 y 偏移，悬浮但不突兀）
 * - 按压反馈动效参数（scale 0.96 + spring 曲线），页面统一引用
 *
 * 深色模式：每套主题提供浅/深两组 bg 与 accent（card 由全局令牌给出）；
 * 是否使用深色组由「深色模式」三态（跟随系统/浅色/深色）+ 系统实际色模式决定。
 */
import { curves } from '@kit.ArkUI'
import { I18n } from '../common/I18n'

export class ThemeInfo {
  id: string
  name: string
  nameEn: string
  bg: string
  card: string
  accent: string
  textMain: string
  textSub: string
  success: string
  danger: string
  /** 深色模式：页面底色 */
  bgDark: string
  /** 深色模式：主色（浅色主色在深底上过暗的做提亮变体） */
  accentDark: string

  constructor(id: string, name: string, nameEn: string, bg: string, card: string, accent: string,
    textMain: string, textSub: string, success: string, danger: string,
    bgDark: string, accentDark: string) {
    this.id = id
    this.name = name
    this.nameEn = nameEn
    this.card = card
    this.bg = bg
    this.accent = accent
    this.textMain = textMain
    this.textSub = textSub
    this.success = success
    this.danger = danger
    this.bgDark = bgDark
    this.accentDark = accentDark
  }

  /** 显示名（系统语言；模块级常量在 I18n.init 前求值，故运行时取） */
  displayName(): string {
    return I18n.isZh() ? this.name : this.nameEn
  }
}

/**
 * 鸿蒙设计令牌：形态参数（圆角/投影/动效/间距）保持静态常量；
 * 颜色令牌改为随「当前是否深色」解析的静态方法——深色判定存于
 * AppStorage('uiDark')，由 AppState 在深色模式变化时写入并触发全页刷新。
 */
export class Design {
  /** 卡片圆角（HarmonyOS 大卡片惯用 16vp） */
  static readonly RADIUS_CARD: number = 16
  /** 控件圆角（按钮/输入 12vp） */
  static readonly RADIUS_CONTROL: number = 12
  /** 小元素圆角（标签/缩略图 8vp） */
  static readonly RADIUS_SMALL: number = 8
  /** 胶囊圆角（BorderRadiusStyle 圆角胶囊） */
  static readonly RADIUS_PILL: number = 999

  /** 按压缩放（HarmonyOS 按压反馈） */
  static readonly PRESS_SCALE: number = 0.97

  /**
   * 动效曲线统一走物理弹簧（官方建议优先物理曲线，见 docs/harmonyos-design-reference.md §3）。
   * springMotion 为 API 9+；物理曲线下 animation/animateTo 的 duration 不生效，
   * 时长由 response（自然振动周期，秒）与 dampingFraction（阻尼）决定。
   */
  static readonly pressCurve: ICurve = curves.springMotion(0.25, 0.85)
  /** 布局/收放/旋转等界面状态变化 */
  static readonly motionCurve: ICurve = curves.springMotion(0.4, 0.86)

  /**
   * 抽屉式页面转场（用户指定风格）：确定性曲线——页面级转场需要与
   * 系统返回手势衔接、观感稳定，物理弹簧的过冲在整页位移上显得发飘
   * （上一轮真机反馈「切换页面闪一下」的教训）。FastOutSlowIn 即
   * 官方标准曲线 cubic-bezier(0.4, 0.0, 0.2, 1.0)。
   */
  static readonly DRAWER_DURATION: number = 320
  static readonly DRAWER_CURVE: Curve = Curve.FastOutSlowIn

  /** 页面左右留白 */
  static readonly PAD_PAGE: number = 16
  /** 卡片内边距 */
  static readonly PAD_CARD: number = 16

  /** 状态色（明暗通用）：成功 / 警示 / 危险 */
  static readonly SUCCESS: string = '#34C759'
  static readonly WARNING: string = '#E0A030'
  static readonly DANGER: string = '#E0403C'

  /** 浅色：卡片底 */
  static readonly SURFACE_LIGHT: string = '#FFFFFF'
  /** 深色：卡片底（HarmonyOS 深色一/二级面） */
  static readonly SURFACE_DARK: string = '#1C1C1E'
  /** 深色：嵌套浅底块（思考块/表格/输入底） */
  static readonly SURFACE_SUB_DARK: string = '#2A2A2C'

  /** 当前是否深色（AppState 写入 AppStorage('uiDark')） */
  static isDark(): boolean {
    const v = AppStorage.get<boolean>('uiDark')
    return v === true
  }

  /** 主文字色（dark 由调用处传入，建立渲染依赖） */
  static TEXT_MAIN(dark: boolean): string {
    return dark ? '#F2F3F5' : '#1A1A1A'
  }

  /** 次文字色 */
  static TEXT_SUB(dark: boolean): string {
    return dark ? '#A6ABB5' : '#7A7E87'
  }

  /** 辅助/弱文字色 */
  static TEXT_HINT(dark: boolean): string {
    return dark ? '#6E7480' : '#A6ABB5'
  }

  /** 分隔线/浅底色 */
  static FILL_LIGHT(dark: boolean): string {
    return dark ? Design.SURFACE_SUB_DARK : '#F4F5F7'
  }

  /** 卡片底色（页面卡片 / 气泡 / 弹层） */
  static SURFACE(dark: boolean): string {
    return dark ? Design.SURFACE_DARK : Design.SURFACE_LIGHT
  }

  /** 嵌套浅底块（思考块、代码底、表格头等卡片内的次级面） */
  static SURFACE_SUB(dark: boolean): string {
    return dark ? Design.SURFACE_SUB_DARK : '#F3F4F6'
  }

  /** 主色 8% 透明度底色（标签/选中态通用） */
  static chipBg(accent: string): string {
    return accent + '14'
  }

  /** 主色 20% 透明度底色（选中项底） */
  static chipBgStrong(accent: string): string {
    return accent + '33'
  }

  /** 卡片投影：浅色低透明；深色改纯黑加深（低透明阴影在深底上不可见） */
  static shadowColor(dark: boolean): string {
    return dark ? '#80000000' : '#14000000'
  }

  /** 卡片投影全参：radius 16 / y 4，颜色随深浅 */
  static cardShadow(dark: boolean): ShadowOptions {
    return {
      radius: 16,
      color: Design.shadowColor(dark),
      offsetX: 0,
      offsetY: 4
    }
  }

  /** 遮罩色 */
  static scrim(dark: boolean): string {
    return dark ? '#99000000' : '#66000000'
  }

  /** 主色 8% 透明度选中底（工作区/公告列表选中行） */
  static selectedBg(accent: string): string {
    return accent + '14'
  }

  /** 危险色 8% 透明度底色（停止/删除标签） */
  static dangerBg(): string {
    return Design.DANGER + '14'
  }

  /** 警示色 8% 透明度底色（待处理标签） */
  static warningBg(): string {
    return Design.WARNING + '14'
  }

  /** 成功色 12% 透明度底色（已连接/在线标签） */
  static successBg(): string {
    return Design.SUCCESS + '1F'
  }

  /** 悬浮胶囊底：浅色为半透明白，深色为深灰半透明 */
  static capsuleBg(dark: boolean): string {
    return dark ? '#F01C1C1E' : '#F7FFFFFF'
  }

  /** 描边色：浅色黑 8%，深色白 10% */
  static borderHair(dark: boolean): string {
    return dark ? '#1AFFFFFF' : '#14000000'
  }

  /** 表格分隔线 */
  static tableBorder(dark: boolean): string {
    return dark ? '#33FFFFFF' : '#E5E7EB'
  }

  /** 状态栏安全区高度（vp）。EntryAbility 在首帧前写入，全屏沉浸布局下页面顶部需避让 */
  static safeTop(): number {
    const v = AppStorage.get<number>('safeTopVp')
    return v !== undefined && v > 0 ? v : 0
  }

  /** 手势指示条安全区高度（vp），底栏/输入栏内容避让用 */
  static safeBottom(): number {
    const v = AppStorage.get<number>('safeBottomVp')
    return v !== undefined && v > 0 ? v : 0
  }
}

export class Theme {
  private static readonly ALL: ThemeInfo[] = [
    new ThemeInfo('deep-space', '深空', 'Deep Space', '#F1F3F5', '#FFFFFF', '#0A59F7', '#1A1A1A', '#7A7E87', '#34C759', '#E0403C',
      '#121214', '#4D8CFF'),
    new ThemeInfo('sunset', '落日', 'Sunset', '#FDF2E9', '#FFFFFF', '#EA580C', '#3B2A20', '#8A6A55', '#34C759', '#E0403C',
      '#17120E', '#F97316'),
    new ThemeInfo('elbphil', '易北爱乐厅', 'Elbphilharmonie', '#EAF1FB', '#FFFFFF', '#1D4ED8', '#1E293B', '#64748B', '#34C759', '#E0403C',
      '#0F141C', '#6B9BFF'),
    new ThemeInfo('steppe', '草原孤塔', 'Steppe Tower', '#F2F7EE', '#FFFFFF', '#3F6212', '#25321E', '#6B7A55', '#34C759', '#E0403C',
      '#101410', '#9DBE5A')
  ]

  static get(id: string): ThemeInfo {
    for (const t of Theme.ALL) {
      if (t.id === id) {
        return t
      }
    }
    return Theme.ALL[0]
  }

  static all(): ThemeInfo[] {
    return Theme.ALL
  }

  /** 页面底色：按传入深色判定取浅/深变体 */
  static bgOf(t: ThemeInfo, dark: boolean): string {
    return dark ? t.bgDark : t.bg
  }

  /** 主色：按传入深色判定取浅/深变体 */
  static accentOf(t: ThemeInfo, dark: boolean): string {
    return dark ? t.accentDark : t.accent
  }
}
