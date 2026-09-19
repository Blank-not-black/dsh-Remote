import { Theme, Design } from '../../models/Theme'
import { I18n } from '../../common/I18n'

/**
 * 平板分栏内容区空态：栈中没有 NavDestination 时由 Navigation 的
 * navBar 区域展示（splitPlaceholder 语义：仅 UI 展示、不受路由栈管理，
 * 见 developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-navigation-split-mode）。
 *
 * 对齐桌面端 WebUI 点开会话前右栏留白的形态：logo + 引导文案。
 */
@Component
export struct SplitEmpty {
  @StorageLink('uiDark') uiDark: boolean = false
  @StorageLink('uiTheme') uiTheme: string = 'deep-space'

  private pageBg(): string {
    return Theme.bgOf(Theme.get(this.uiTheme), this.uiDark)
  }

  build() {
    Column({ space: 14 }) {
      Text('◆')
        .fontSize(56)
        .fontColor(Theme.accentOf(Theme.get(this.uiTheme), this.uiDark))
        .opacity(0.5)
      Text(I18n.t('DSH Remote', 'DSH Remote'))
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .fontColor(Design.TEXT_MAIN(this.uiDark))
      Text(I18n.t('从左侧选择一个会话开始', 'Pick a session on the left to start'))
        .fontSize(14)
        .fontColor(Design.TEXT_SUB(this.uiDark))
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor(this.pageBg())
  }
}
