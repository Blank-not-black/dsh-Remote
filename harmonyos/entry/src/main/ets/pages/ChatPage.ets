import { router } from '@kit.ArkUI'
import { ChatView } from './ChatView'
import { Design } from '../models/Theme'

/**
 * 会话详情页壳（手机端 @Entry 路由页）：从 router 参数取 sessionId
 * 转发给可内嵌的 ChatView。平板分栏布局不走本页，由 TabletIndex 的
 * navDestination builder 直接挂 ChatView。
 */
@Entry
@Component
struct ChatPage {
  @State sessionId: string = ''

  aboutToAppear(): void {
    const params = router.getParams() as Record<string, Object>
    this.sessionId = String(params?.['sessionId'] ?? '')
  }

  build() {
    Column() {
      ChatView({ sessionId: this.sessionId })
    }
    .width('100%')
    .height('100%')
  }

  /**
   * 抽屉式转场：子页自右滑入、底层左移；返回反向。
   * PageTransitionEnter/Exit 只能直写在 pageTransition() 内（ArkUI 语法限制），
   * 参数统一取 Design 抽屉令牌。
   */
  pageTransition(): void {
    PageTransitionEnter({ type: RouteType.Push, duration: Design.DRAWER_DURATION, curve: Design.DRAWER_CURVE })
      .slide(SlideEffect.Right)
    PageTransitionExit({ type: RouteType.Push, duration: Design.DRAWER_DURATION, curve: Design.DRAWER_CURVE })
      .slide(SlideEffect.Left)
    PageTransitionEnter({ type: RouteType.Pop, duration: Design.DRAWER_DURATION, curve: Design.DRAWER_CURVE })
      .slide(SlideEffect.Left)
    PageTransitionExit({ type: RouteType.Pop, duration: Design.DRAWER_DURATION, curve: Design.DRAWER_CURVE })
      .slide(SlideEffect.Right)
  }
}
