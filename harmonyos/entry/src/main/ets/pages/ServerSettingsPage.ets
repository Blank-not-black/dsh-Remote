import { router } from '@kit.ArkUI'
import { Theme, Design } from '../models/Theme'
import { AppState } from '../services/AppState'
import { ServerInfo } from '../models/ServerInfo'
import { GatewayApi } from '../services/GatewayApi'
import { StorageService } from '../services/StorageService'
import { ScanService } from '../services/ScanService'
import { PairParser } from '../services/PairParser'
import { Constants } from '../common/Constants'
import { I18n } from '../common/I18n'

/**
 * 服务器管理：列表增删改、URL/token 录入、连接测试、设为当前。
 */
@Entry
@Component
struct ServerSettingsPage {
  @StorageLink('appState') appState: AppState = AppState.instance

  @State formId: string = ''
  @State formUrl: string = ''
  @State formToken: string = ''
  @State formNote: string = ''
  @State formGroup: string = ''
  @State testResult: string = ''
  /** 测试连接结果是否通过（决定文字颜色） */
  @State testOk: boolean = false
  /** 深浅判定（AppState 写入）；变更驱动整页刷新 */
  @StorageLink('uiDark') uiDark: boolean = false
  /** 当前主题 id 原语（AppState 写入）；主题切换驱动整页刷新 */
  @StorageLink('uiTheme') uiTheme: string = 'deep-space'

  private pageBg(): string {
    return Theme.bgOf(Theme.get(this.uiTheme), this.uiDark)
  }

  private accent(): string {
    return Theme.accentOf(Theme.get(this.uiTheme), this.uiDark)
  }

  private surface(): string {
    return Design.SURFACE(this.uiDark)
  }

  /** 无主题上下文的 accent（本页始终有 appState，直接取主题） */
  private accentOrBlue(): string {
    return this.accent()
  }

  build() {
    Column() {
      Row() {
        Row() {
          Image($r('app.media.ic_back'))
            .width(24)
            .height(24)
            .fillColor(Design.TEXT_MAIN(this.uiDark))
        }
        .width(40)
        .height(40)
        .justifyContent(FlexAlign.Center)
        .margin({ left: -8 })
        .borderRadius(Design.RADIUS_PILL)
        .onClick(() => {
          router.back()
        })
        Text(I18n.t('服务器管理', 'Servers'))
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .fontColor(Design.TEXT_MAIN(this.uiDark))
          .margin({ left: 4 })
        Blank()
        Row({ space: 4 }) {
          Image($r('app.media.ic_scan'))
            .width(20)
            .height(20)
            .fillColor(this.accent())
          Text(I18n.t('扫码配对', 'Scan to pair'))
            .fontSize(14)
            .fontColor(this.accent())
        }
        .onClick(() => {
          this.scanPair()
        })
      }
      .width('100%')
      .padding({ left: 12, right: 16, top: 10 + Design.safeTop(), bottom: 10 })
      .backgroundColor(this.surface())

      Scroll() {
        Column({ space: 12 }) {
          this.formCard()
          this.listCard()
        }
        .padding(16)
        .width('100%')
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.pageBg())
  }

  @Builder
  formCard() {
    Column({ space: 10 }) {
      Row() {
        Text(this.formId.length > 0 ? I18n.t('编辑服务器', 'Edit server') : I18n.t('新增服务器', 'Add server'))
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
        Blank()
        if (this.formId.length > 0) {
          Text(I18n.t('清空', 'Clear'))
            .fontSize(13)
            .fontColor(this.accent())
            .onClick(() => {
              this.clearForm()
            })
        }
      }.width('100%')

      TextInput({ text: $$this.formUrl, placeholder: I18n.t('地址，如 192.168.1.10:8787', 'Address, e.g. 192.168.1.10:8787') })
        .height(42)
        .fontSize(14)
      TextInput({ text: $$this.formToken, placeholder: I18n.t('令牌（Bearer token）', 'Token (Bearer)') })
        .height(42)
        .fontSize(14)
        .type(InputType.Password)
      TextInput({ text: $$this.formNote, placeholder: I18n.t('备注（可选）', 'Note (optional)') })
        .height(42)
        .fontSize(14)
      TextInput({ text: $$this.formGroup, placeholder: I18n.t('分组（默认 默认）', 'Group (default: Default)') })
        .height(42)
        .fontSize(14)

      Row({ space: 10 }) {
        Button(I18n.t('保存', 'Save'))
          .fontSize(14)
          .height(38)
          .layoutWeight(1)
          .backgroundColor(this.accent())
          .onClick(() => {
            this.saveForm()
          })
        Button(I18n.t('测试连接', 'Test connection'))
          .fontSize(14)
          .height(38)
          .layoutWeight(1)
          .backgroundColor(Design.TEXT_SUB(this.uiDark))
          .onClick(() => {
            this.testConnection()
          })
      }.width('100%')

      if (this.testResult.length > 0) {
        Text(this.testResult)
          .fontSize(12)
          .fontColor(this.testOk ? Design.SUCCESS : Design.DANGER)
          .width('100%')
      }
    }
    .width('100%')
    .padding(16)
    .backgroundColor(this.surface())
    .borderRadius(Design.RADIUS_CARD)
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  listCard() {
    Column({ space: 8 }) {
      Row() {
        Text(I18n.t('已保存的服务器', 'Saved servers'))
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
      }.width('100%')

      if (this.appState.servers.length === 0) {
        Text(I18n.t('暂无服务器，请在上方添加', 'No servers; add one above'))
          .fontSize(13)
          .fontColor(Design.TEXT_HINT(this.uiDark))
          .width('100%')
          .padding({ top: 8, bottom: 8 })
      } else {
        ForEach(this.appState.servers, (item: ServerInfo) => {
          Column({ space: 6 }) {
            Row() {
              Text(item.normalizedUrl())
                .fontSize(15)
                .fontWeight(FontWeight.Medium)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .layoutWeight(1)
              if (this.appState.server && this.appState.server.id === item.id) {
                Text(I18n.t('当前', 'Active'))
                  .fontSize(11)
                  .fontColor(Design.SUCCESS)
                  .padding({ left: 6, right: 6, top: 2, bottom: 2 })
                  .backgroundColor(Design.successBg())
                  .borderRadius(Design.RADIUS_PILL)
              }
            }.width('100%')

            Row() {
              Text(item.note.length > 0 ? item.note : item.group)
                .fontSize(12)
                .fontColor(Design.TEXT_SUB(this.uiDark))
              Blank()
              Text(item.token.length > 0 ? I18n.t('已配置令牌', 'Token set') : I18n.t('无令牌', 'No token'))
                .fontSize(12)
                .fontColor(item.token.length > 0 ? Design.SUCCESS : Design.DANGER)
            }.width('100%')

            Row({ space: 8 }) {
              Text(I18n.t('设为当前', 'Set active'))
                .fontSize(13)
                .fontColor(this.accent())
                .onClick(() => {
                  this.appState.setCurrentServer(item.id)
                  this.testResult = I18n.t('已切换：', 'Switched: ') + item.normalizedUrl()
                })
              Text(I18n.t('编辑', 'Edit'))
                .fontSize(13)
                .fontColor(Design.TEXT_SUB(this.uiDark))
                .onClick(() => {
                  this.loadForm(item)
                })
              Text(I18n.t('删除', 'Delete'))
                .fontSize(13)
                .fontColor(Design.DANGER)
                .onClick(() => {
                  this.confirmDelete(item)
                })
            }.width('100%')
          }
          .width('100%')
          .padding(12)
          .backgroundColor(Design.SURFACE_SUB(this.uiDark))
          .borderRadius(Design.RADIUS_CARD)
        }, (item: ServerInfo) => item.id)
      }
    }
    .width('100%')
    .padding(16)
    .backgroundColor(this.surface())
    .borderRadius(Design.RADIUS_CARD)
    .alignItems(HorizontalAlign.Start)
  }

  private clearForm(): void {
    this.formId = ''
    this.formUrl = ''
    this.formToken = ''
    this.formNote = ''
    this.formGroup = ''
    this.testResult = ''
    this.testOk = false
  }

  private loadForm(item: ServerInfo): void {
    this.formId = item.id
    this.formUrl = item.url
    this.formToken = item.token
    this.formNote = item.note
    this.formGroup = item.group
    this.testResult = ''
  }

  private saveForm(): void {
    let url = this.formUrl.trim()
    if (url.length === 0) {
      this.testResult = I18n.t('请输入网关地址', 'Enter the gateway address')
      return
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'http://' + url
    }
    const id: string = this.formId.length > 0 ? this.formId : 's-' + Date.now().toString(36)
    const group: string = this.formGroup.trim().length > 0 ? this.formGroup.trim() : Constants.DEFAULT_GROUP
    const note: string = this.formNote.trim()
    const token: string = this.formToken.trim()

    const list: ServerInfo[] = []
    let replaced: boolean = false
    for (const s of this.appState.servers) {
      if (s.id === id) {
        list.push(new ServerInfo(id, url, note, group, token))
        replaced = true
      } else {
        list.push(s)
      }
    }
    if (!replaced) {
      list.push(new ServerInfo(id, url, note, group, token))
    }
    this.appState.saveServers(list, id)
    this.clearForm()
    this.testResult = I18n.t('已保存并设为当前', 'Saved and set active')
    this.testOk = true
  }

  /** 扫码配对：解析 dshremote://pair 并导入服务器 */
  private async scanPair(): Promise<void> {
    const ctx = StorageService.getContext()
    if (!ctx) {
      this.testResult = I18n.t('无法获取应用上下文', 'App context unavailable')
      return
    }
    this.testResult = I18n.t('正在打开扫码…', 'Opening scanner…')
    const raw = await ScanService.scanText(ctx)
    if (raw.length === 0) {
      this.testResult = I18n.t('未识别到二维码', 'No QR code detected')
      return
    }
    const payload = PairParser.parsePairUrl(raw)
    if (!payload) {
      this.testResult = I18n.t('不是有效的 DSH Remote 配对二维码', 'Not a valid DSH Remote pairing QR code')
      return
    }
    const ok = this.appState.addServersFromPair(payload.token, payload.servers)
    this.testOk = ok
    this.testResult = ok
      ? I18n.t('配对成功：已导入 ', 'Paired: imported ') + payload.servers.length.toString() + I18n.t(' 个地址', ' addresses')
      : I18n.t('配对失败：二维码内容不完整', 'Pairing failed: incomplete QR content')
  }

  private async testConnection(): Promise<void> {
    let url = this.formUrl.trim()
    if (url.length === 0) {
      this.testResult = I18n.t('请先输入地址', 'Enter an address first')
      this.testOk = false
      return
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'http://' + url
    }
    const token = this.formToken.trim()
    const start = Date.now()
    try {
      const h = await GatewayApi.getHealth(url, 8000)
      const ms = Date.now() - start
      const upstream = h.upstreamOk ? I18n.t('上游正常', 'Upstream OK') : I18n.t('上游降级', 'Upstream degraded')
      // /health 免鉴权：没有令牌就不能声称"配置正确"
      if (token.length === 0) {
        this.testResult = `网关可达（${ms}ms）版本 ${h.version}，${upstream}；未填令牌，无法校验鉴权`
        this.testOk = false
        return
      }
      try {
        await GatewayApi.diagnosticsOk(url, token, 8000)
        this.testResult = `连接成功（${ms}ms）版本 ${h.version}，${upstream}，令牌有效`
        this.testOk = true
      } catch (e) {
        const msg = (e as Error).message
        this.testResult = msg === 'AUTH'
          ? `网关可达（${ms}ms），但令牌无效（401）`
          : `网关可达（${ms}ms），鉴权检查失败：${msg}`
        this.testOk = false
      }
    } catch (e) {
      this.testResult = I18n.t('连接失败：', 'Connection failed: ') + (e as Error).message
      this.testOk = false
    }
  }

  private confirmDelete(item: ServerInfo): void {
    AlertDialog.show({
      title: I18n.t('删除服务器', 'Delete server'),
      message: I18n.t('确定删除 ', 'Delete ') + item.normalizedUrl() + I18n.t(' 吗？', '?'),
      primaryButton: {
        value: I18n.t('取消', 'Cancel'),
        action: () => {
        }
      },
      secondaryButton: {
        value: I18n.t('删除', 'Delete'),
        action: () => {
          this.deleteServer(item.id)
        }
      }
    })
  }

  private deleteServer(id: string): void {
    const list: ServerInfo[] = []
    for (const s of this.appState.servers) {
      if (s.id !== id) {
        list.push(s)
      }
    }
    const activeId: string = list.length > 0 ? list[0].id : ''
    this.appState.saveServers(list, activeId)
    this.testResult = I18n.t('已删除', 'Deleted')
  }
}