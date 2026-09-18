import { common, ConfigurationConstant } from '@kit.AbilityKit'
import { AppState } from '../services/AppState'
import { Constants } from './Constants'

/**
 * 应用级深浅色模式同步：把 AppState.darkMode（system/light/dark）落到
 * ApplicationContext.setColorMode。
 *
 * 为什么必须做：ArkUI 未显式指定 fontColor 的文字、TextInput 等默认走
 * 系统资源色；不调 setColorMode 时「系统深色 + App 内浅色主题」会出现
 * 白底白字（服务器管理页实测）。COLOR_MODE_NOT_SET = 跟随系统。
 *
 * 调用时机：EntryAbility.loadContent 完成后（首帧前初始化）与
 * 设置页切换深浅模式（Index.onUiDarkChange 监听 uiDark 原语变化）。
 */
export class AppColorMode {
  private static lastApplied: string = ''

  /**
   * 按当前 AppState.darkMode 同步应用 colorMode；失败静默（下次冷启动兜底）。
   * 仅在 loadContent 完成后调用（官方约束：setColorMode 需页面加载完成后调用，
   * 提前调用会异常导致启动闪退）；同值幂等跳过，避免重复触发全局重渲染。
   */
  static apply(ctx: common.UIAbilityContext): void {
    try {
      const mode = AppState.instance.darkMode
      if (mode === AppColorMode.lastApplied) {
        return
      }
      const appContext = ctx.getApplicationContext()
      if (mode === Constants.DARK_LIGHT) {
        appContext.setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT)
      } else if (mode === Constants.DARK_DARK) {
        appContext.setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_DARK)
      } else {
        appContext.setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET)
      }
      AppColorMode.lastApplied = mode
    } catch (e) {
      // 个别窗口/上下文场景取不到 applicationContext，忽略
    }
  }
}
