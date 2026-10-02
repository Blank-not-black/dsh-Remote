import { Design } from '../models/Theme'

/**
 * 骨架屏加载态（借鉴官方 harmonyos-cases/cases 的 skeletondiagram 案例，
 * https://gitee.com/harmonyos-cases/cases —— 灰色块还原条目布局 +
 * animateTo 透明度闪烁）：数据首拉期间替代白屏/空态，加载完成后由调用方
 * 条件切换为真实内容。
 *
 * 闪烁驱动：aboutToAppear 起一次性循环 animateTo（iterations: -1），
 * 组件下树后动画随节点销毁停止，无需手动清理。opacity 挂在每个骨架块上，
 * 状态变量变更经 animateTo 闭包捕获生效。
 */
@Component
export struct SkeletonList {
  @StorageLink('uiDark') uiDark: boolean = false
  /** 骨架条目数 */
  rows: number = 5
  /** 骨架块底色：SURFACE_SUB 嵌套底（默认，用于分组块/面板内） */
  private skeletonOpacity: number = 0.4

  aboutToAppear(): void {
    this.getUIContext().animateTo({
      duration: 900,
      curve: Curve.EaseInOut,
      iterations: -1,
      playMode: PlayMode.Alternate
    }, () => {
      this.skeletonOpacity = 0.9
    })
  }

  private rowKeys(): string[] {
    const keys: string[] = []
    for (let i = 0; i < this.rows; i++) {
      keys.push(i.toString())
    }
    return keys
  }

  /** 标题占位宽：86/62/78/92/70% 循环错落，避免整列同宽的死板感 */
  private titleWidth(idx: number): string {
    const percents: number[] = [86, 62, 78, 92, 70]
    return percents[idx % percents.length].toString() + '%'
  }

  build() {
    Column({ space: 10 }) {
      ForEach(this.rowKeys(), (key: string) => {
        Row({ space: 10 }) {
          // 状态点占位
          Circle()
            .width(8)
            .height(8)
            .fill(Design.FILL_LIGHT(this.uiDark))
          Column({ space: 6 }) {
            Row()
              .width(this.titleWidth(Number(key)))
              .height(14)
              .borderRadius(Design.RADIUS_SMALL)
              .backgroundColor(Design.FILL_LIGHT(this.uiDark))
            Row()
              .width('42%')
              .height(10)
              .borderRadius(Design.RADIUS_SMALL)
              .backgroundColor(Design.FILL_LIGHT(this.uiDark))
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
        }
        .width('100%')
        .padding({ left: 14, right: 14, top: 14, bottom: 14 })
        .borderRadius(Design.RADIUS_CARD)
        .backgroundColor(Design.SURFACE_SUB(this.uiDark))
        .opacity(this.skeletonOpacity)
      }, (key: string) => key)
    }
    .width('100%')
  }
}

/**
 * 模型面板加载骨架：分组标题块 + chip 行占位（对齐真实面板的分组结构）。
 */
@Component
export struct SkeletonModels {
  @StorageLink('uiDark') uiDark: boolean = false
  private skeletonOpacity: number = 0.4

  aboutToAppear(): void {
    this.getUIContext().animateTo({
      duration: 900,
      curve: Curve.EaseInOut,
      iterations: -1,
      playMode: PlayMode.Alternate
    }, () => {
      this.skeletonOpacity = 0.9
    })
  }

  build() {
    Column({ space: 16 }) {
      ForEach(['0', '1', '2'], (key: string) => {
        Column({ space: 10 }) {
          // 分组标题占位（对齐真实面板的主色竖条 + 标题）
          Row({ space: 8 }) {
            Column()
              .width(3)
              .height(14)
              .borderRadius(Design.RADIUS_PILL)
              .backgroundColor(Design.FILL_LIGHT(this.uiDark))
            Row()
              .width('28%')
              .height(12)
              .borderRadius(Design.RADIUS_SMALL)
              .backgroundColor(Design.FILL_LIGHT(this.uiDark))
          }
          .width('100%')
          // chip 占位行
          Row({ space: 8 }) {
            ForEach(['0', '1', '2'], (c: string) => {
              Row()
                .width(c === '1' ? 96 : 72)
                .height(30)
                .borderRadius(Design.RADIUS_PILL)
                .backgroundColor(Design.FILL_LIGHT(this.uiDark))
            }, (c: string) => c)
          }
          .width('100%')
        }
        .width('100%')
        .opacity(this.skeletonOpacity)
      }, (key: string) => key)
    }
    .width('100%')
  }
}
