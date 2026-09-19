/**
 * 统一抽屉式页面转场（用户指定风格）：子页面像抽屉一样从右侧滑入、
 * 返回时滑出；底层页面同时向左轻移 -14%（视差），营造上层抽屉的层次感。
 *
 * 两套接入点共用同一组时长/曲线令牌（Design.DRAWER_*）：
 * - 手机端：@Entry 路由页在 pageTransition() 里直写 PageTransitionEnter/Exit
 *   + slide（ArkUI 语法限制：这两个语句只能出现在页面组件的 pageTransition
 *   函数体内，不能抽成普通类方法），见 ChatPage 等页面的 drawerPageTransition()。
 * - 平板端：TabletIndex 用 customNavContentTransition 注册全局代理，
 *   NavDestination 在 onReady 时用 PageTransitions.attach(context, state)
 *   登记位移状态；转场回调经 animateTo 驱动 DrawerState.x，
 *   官方示例 13「自定义转场动画」的注册-驱动模式。
 *
 * 官方出处：
 * - developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-page-transition-animation
 * - developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-navigation-animation
 * - developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-basic-components-navigation
 *   （customNavContentTransition11+ / NavigationTransitionProxy / NavigationOperation）
 */
import { UIContext } from '@kit.ArkUI'
import { Design } from '../models/Theme'

/** NavDestination 的抽屉位移状态：TabletIndex 持有并写入 .translate() */
export class DrawerState {
  x: string = '0'
  /** onReady 时登记的 navDestinationId，onDisAppear 据此注销 */
  navId: string = ''
}

interface DrawerCallback {
  start: (isPush: boolean, enter: boolean) => void
  finish: (isPush: boolean, enter: boolean) => void
}

class DrawerRegistry {
  private static callbacks: Map<string, DrawerCallback> = new Map()

  static register(id: string, cb: DrawerCallback): void {
    DrawerRegistry.callbacks.set(id, cb)
  }

  static unregister(id: string): void {
    DrawerRegistry.callbacks.delete(id)
  }

  static get(id: string): DrawerCallback | undefined {
    return DrawerRegistry.callbacks.get(id)
  }
}

export class PageTransitions {
  /**
   * 平板端：NavDestination.onReady(context) 里调用，登记该页的位移状态。
   * 进入方式决定起点（push 自右入 / pop 自左回位），底层页带 -14% 视差。
   */
  static attach(context: NavDestinationContext, state: DrawerState): void {
    const id = context.navDestinationId ?? ''
    if (id.length === 0) {
      return
    }
    state.navId = id
    DrawerRegistry.register(id, {
      start: (isPush: boolean, enter: boolean) => {
        if (isPush) {
          state.x = enter ? '100%' : '-14%'
        } else {
          state.x = enter ? '-14%' : '100%'
        }
      },
      finish: (isPush: boolean, enter: boolean) => {
        state.x = enter ? '0' : (isPush ? '-14%' : '100%')
      }
    })
  }

  /** NavDestination.onDisAppear 里调用：按 state 记录的 id 注销回调防泄漏 */
  static detachById(state: DrawerState): void {
    if (state.navId.length > 0) {
      DrawerRegistry.unregister(state.navId)
      state.navId = ''
    }
  }

  /**
   * 平板端：TabletIndex 的 Navigation 挂
   * .customNavContentTransition(PageTransitions.navDelegate())
   * 自定义动画仅作用于 PUSH/POP（子页抽屉进出）：
   * - NavBar 参与（index === -1）→ undefined，系统默认；
   * - Replace（侧栏主视图平级切换）→ undefined，系统 Replace 自带交叉淡入。
   * NavigationTransitionProxy.from/to 是只读信息对象，不支持直接挂
   * opacity/translate 属性动画（官方 API 表），故 Replace 无法用代理
   * 驱动自绘动画，主视图切换交给系统默认即是观感最稳的选择。
   */
  static navDelegate(uiContext: UIContext): (from: NavContentInfo, to: NavContentInfo, operation: NavigationOperation) =>
    NavigationAnimatedTransition | undefined {
    return (from: NavContentInfo, to: NavContentInfo, operation: NavigationOperation) => {
      if (from.index === -1 || to.index === -1 || operation === NavigationOperation.REPLACE) {
        return undefined
      }
      const fromCb = DrawerRegistry.get(from.navDestinationId ?? '')
      const toCb = DrawerRegistry.get(to.navDestinationId ?? '')
      if (fromCb === undefined || toCb === undefined) {
        return undefined
      }
      const customAnimation: NavigationAnimatedTransition = {
        timeout: Design.DRAWER_DURATION + 250,
        transition: (transitionProxy: NavigationTransitionProxy) => {
          const fCb = fromCb
          const tCb = toCb
          const push = operation === NavigationOperation.PUSH
          // 起点：上层页 push 自 100% 入 / pop 向 100% 出；底层页带 -14% 视差
          fCb.start(push, false)
          tCb.start(push, true)
          uiContext.animateTo({
            duration: Design.DRAWER_DURATION,
            curve: Design.DRAWER_CURVE,
            onFinish: () => {
              transitionProxy.finishTransition()
            }
          }, () => {
            fCb.finish(push, false)
            tCb.finish(push, true)
          })
        }
      }
      return customAnimation
    }
  }
}
