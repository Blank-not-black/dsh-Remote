import { mediaquery } from '@kit.ArkUI'
import { AppState } from '../services/AppState'

/**
 * 系统深浅原语：媒体查询 '(dark-mode: true)' → AppStorage('systemDark')，
 * AppState.onSystemDarkChange 在「深色=跟随系统」时据此刷新 uiDark。
 *
 * 注册时机坑（与 Breakpoint 同款）：挂在 loadContent 之前 UIContext 上的
 * 监听注册即同步的初值可靠，但收不到后续 change 事件——因此 EntryAbility
 * 早期注册只负责首帧初值，Index.aboutToAppear 必须用页面自身 UIContext
 * 重注册（watch 幂等，先 off 旧监听）接管运行期系统切换。
 */
export class SystemDarkWatch {
  private static listener: mediaquery.MediaQueryListener | null = null

  static watch(ui: UIContext): void {
    if (SystemDarkWatch.listener !== null) {
      try {
        SystemDarkWatch.listener.off('change')
      } catch (e) {
        // 旧监听所属 UIContext 可能已失效，忽略解绑异常
      }
      SystemDarkWatch.listener = null
    }
    const l: mediaquery.MediaQueryListener = ui.getMediaQuery().matchMediaSync('(dark-mode: true)')
    l.on('change', (result: mediaquery.MediaQueryResult) => {
      SystemDarkWatch.apply(result.matches === true)
    })
    SystemDarkWatch.listener = l
    // 注册即同步初值（幂等：与 EntryAbility 早期注册写同一原语）
    SystemDarkWatch.apply(l.matches === true)
  }

  /** 统一落点：写原语 + 通知 AppState（仅跟随系统模式时实际生效） */
  static apply(systemDark: boolean): void {
    AppStorage.setOrCreate('systemDark', systemDark)
    AppState.instance.onSystemDarkChange(systemDark)
  }
}
