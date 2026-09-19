let storage = new LocalStorage();

/**
 * 2x2 桌面服务卡片：网关状态 + 运行中会话数 + 最近会话标题。
 * 数据经 EntryFormAbility 的 FormBindingData 注入（LocalStorageProp 绑定）；
 * 点击刷新按钮 postCardAction(message) 触发 onFormEvent 重新读快照；
 * 点击卡片主体 postCardAction(router) 拉起应用主页。
 */
@Entry(storage)
@Component
struct DshFormCard {
  @LocalStorageProp('title') title: string = 'DSH Remote';
  @LocalStorageProp('running') running: string = '0';
  @LocalStorageProp('stateText') stateText: string = '未连接';
  @LocalStorageProp('stateOn') stateOn: string = '0';

  private stateColor(): string {
    return this.stateOn === '1' ? '#34C759' : '#A6ABB5';
  }

  build() {
    Column() {
      // 顶行：状态点 + 标题
      Row({ space: 6 }) {
        Circle()
          .width(8)
          .height(8)
          .fill(this.stateColor())
        Text('DSH Remote')
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor('#1A1A1A')
          .maxLines(1)
        Blank()
        Text(this.stateText)
          .fontSize(10)
          .fontColor('#7A7E87')
      }
      .width('100%')

      // 中部：运行中会话数
      Row({ space: 4 }) {
        Text(this.running)
          .fontSize(30)
          .fontWeight(FontWeight.Bold)
          .fontColor('#0A59F7')
        Text(this.running === '1' ? '个会话运行中' : '个会话运行中')
          .fontSize(11)
          .fontColor('#7A7E87')
          .margin({ top: 14 })
      }
      .width('100%')
      .margin({ top: 6 })

      // 底部：最近会话标题 + 刷新按钮
      Row({ space: 6 }) {
        Text(this.title)
          .fontSize(11)
          .fontColor('#7A7E87')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Text('刷新')
          .fontSize(11)
          .fontColor('#0A59F7')
          .padding({ left: 8, right: 8, top: 3, bottom: 3 })
          .backgroundColor('#140A59F7')
          .borderRadius(10)
          .onClick(() => {
            postCardAction(this, {
              action: 'message',
              params: { event: 'refresh' }
            });
          })
      }
      .width('100%')
      .margin({ top: 6 })
    }
    .width('100%')
    .height('100%')
    .padding(14)
    .alignItems(HorizontalAlign.Start)
    .justifyContent(FlexAlign.SpaceBetween)
    .onClick(() => {
      postCardAction(this, {
        action: 'router',
        abilityName: 'EntryAbility',
        params: {}
      });
    })
  }
}
