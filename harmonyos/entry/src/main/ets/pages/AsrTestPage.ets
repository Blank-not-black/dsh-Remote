import { router } from '@kit.ArkUI'
import { pasteboard } from '@kit.BasicServicesKit'
import { AsrTestService, AsrEvent } from '../services/AsrTestService'
import { I18n } from '../common/I18n'
import { Theme, Design } from '../models/Theme'

/**
 * 语音识别诊断页（对应 Android 设置页的 ASR 测试面板）：
 * 60 秒 Core Speech Kit 离线中文识别测试，事件流实时展示
 * partial / final / callback / error，结束时给 summary。
 * 结果只在本页展示，不上传。
 */
@Entry
@Component
struct AsrTestPage {
  @StorageLink('uiDark') uiDark: boolean = false
  @StorageLink('uiTheme') uiTheme: string = 'deep-space'

  @State running: boolean = false
  @State statusText: string = I18n.t('尚未开始', 'Not started')
  @State events: AsrEvent[] = []
  @State summaryText: string = ''
  @State copyNote: string = ''

  aboutToAppear() {
    AsrTestService.setListener((list: AsrEvent[]) => {
      this.events = list.slice()
      this.digestEvents()
    })
    if (AsrTestService.isRunning()) {
      this.running = true
      this.events = AsrTestService.getEvents().slice()
      this.digestEvents()
    }
  }

  aboutToDisappear() {
    AsrTestService.setListener(null)
  }

  /** 从事件流提取最新状态行与摘要行 */
  private digestEvents(): void {
    let status = ''
    let summary = ''
    for (const e of this.events) {
      if (e.type === 'status') {
        status = String(e.data['message'] ?? '')
      } else if (e.type === 'summary') {
        summary = I18n.t('结论：', 'Verdict: ') + (e.data['usable'] === true ? I18n.t('可用', 'usable') : I18n.t('不可用', 'unusable')) +
          '，final=' + String(e.data['finalCount'] ?? 0) +
          '，partial=' + String(e.data['partialCount'] ?? 0) +
          '，error=' + String(e.data['errorCount'] ?? 0) +
          I18n.t('，原因=', ', reason=') + String(e.data['reason'] ?? '')
      }
    }
    if (status.length > 0) {
      this.statusText = status
    }
    if (summary.length > 0) {
      this.summaryText = summary
    }
    this.running = AsrTestService.isRunning()
  }

  private accent(): string {
    return Theme.accentOf(Theme.get(this.uiTheme), this.uiDark)
  }

  private surface(): string {
    return Design.SURFACE(this.uiDark)
  }

  private pageBg(): string {
    return Theme.bgOf(Theme.get(this.uiTheme), this.uiDark)
  }

  /** 事件流渲染为一行行日志 */
  private eventLine(e: AsrEvent): string {
    const at = e.atMs.toString() + 'ms'
    const d = e.data
    if (e.type === 'meta') {
      return '[' + at + '] mode=' + String(d['recognizerMode'] ?? '') +
        ' lang=' + String(d['language'] ?? '') +
        ' model=' + String(d['modelType'] ?? '') +
        ' pcm=' + String(d['sampleRate'] ?? '') + '/' + String(d['sampleBit'] ?? '')
    }
    if (e.type === 'status') {
      return '[' + at + '] status=' + String(d['status'] ?? '') + ' ' + String(d['message'] ?? '')
    }
    if (e.type === 'partial' || e.type === 'final') {
      return '[' + at + '] ' + e.type + '#' + String(d['count'] ?? '') + ': ' + String(d['text'] ?? '(empty)')
    }
    if (e.type === 'callback') {
      return '[' + at + '] callback code=' + String(d['eventCode'] ?? '') + ' ' + String(d['message'] ?? '')
    }
    if (e.type === 'error') {
      return '[' + at + '] error=' + String(d['name'] ?? '') + ' code=' + String(d['code'] ?? '') +
        ' ' + String(d['message'] ?? '')
    }
    if (e.type === 'summary') {
      return '[' + at + '] summary usable=' + String(d['usable'] ?? '') +
        ' final=' + String(d['finalCount'] ?? '') + ' partial=' + String(d['partialCount'] ?? '')
    }
    return '[' + at + '] ' + e.type
  }

  private async toggleTest(): Promise<void> {
    if (this.running) {
      AsrTestService.stopTest()
      return
    }
    // 开始前同意弹窗（对齐 Web 端 asrTestConsent）
    AlertDialog.show({
      title: I18n.t('开始语音识别测试', 'Start ASR test'),
      message: I18n.t('测试将使用麦克风录音约 60 秒。识别由系统端侧离线模型完成，日志只在本页展示，不上传。是否继续？', 'The test records the microphone for about 60s. Recognition runs on the on-device offline model; the log stays on this page and is never uploaded. Continue?'),
      primaryButton: { value: I18n.t('取消', 'Cancel'), action: () => { } },
      secondaryButton: {
        value: I18n.t('开始', 'Start'),
        action: () => {
          this.summaryText = ''
          this.statusText = I18n.t('正在启动…', 'Starting…')
          AsrTestService.startTest().then((ok: boolean) => {
            if (!ok) {
              this.statusText = I18n.t('启动失败（见事件流）', 'Start failed (see event log)')
            }
            this.running = AsrTestService.isRunning()
          })
        }
      }
    })
  }

  /** 复制事件流日志（对齐 Web 端 asrTestCopy） */
  private copyLog(): void {
    if (this.events.length === 0) {
      this.copyNote = I18n.t('日志为空', 'Log is empty')
      return
    }
    const lines: string[] = []
    for (const e of this.events) {
      lines.push(this.eventLine(e))
    }
    const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, lines.join('\n'))
    pasteboard.getSystemPasteboard().setData(data).then(() => {
      this.copyNote = I18n.t('日志已复制', 'Log copied')
    }).catch(() => {
      this.copyNote = I18n.t('复制失败', 'Copy failed')
    })
  }

  /** 重新发起麦克风权限请求（永久拒绝时请在系统设置 > 应用 > 权限中开启） */
  private reRequestPermission(): void {
    AsrTestService.requestMicPermission().then((granted: boolean) => {
      this.copyNote = granted ? I18n.t('麦克风权限已授予', 'Microphone permission granted') : I18n.t('权限未授予；可到系统设置 > 应用 > DSH Remote > 权限开启', 'Not granted; enable it in Settings > Apps > DSH Remote > Permissions')
    })
  }

  /** 辅助操作胶囊按钮 */
  @Builder
  assistChip(label: string, onTap: () => void) {
    Text(label)
      .fontSize(12)
      .padding({ left: 12, right: 12, top: 6, bottom: 6 })
      .borderRadius(Design.RADIUS_PILL)
      .backgroundColor(Design.SURFACE_SUB(this.uiDark))
      .fontColor(Design.TEXT_MAIN(this.uiDark))
      .onClick(() => {
        onTap()
      })
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
        Text(I18n.t('语音识别诊断', 'Speech recognition diagnostics'))
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .fontColor(Design.TEXT_MAIN(this.uiDark))
          .margin({ left: 4 })
      }
      .width('100%')
      .padding({ left: 12, right: 16, top: 10 + Design.safeTop(), bottom: 10 })
      .backgroundColor(this.surface())

      Column({ space: 12 }) {
        Column({ space: 4 }) {
          Text(I18n.t('状态：', 'Status: ') + this.statusText)
            .fontSize(14)
            .fontColor(Design.TEXT_MAIN(this.uiDark))
            .width('100%')
          Text(I18n.t('离线中文普通话，短语音 ≤60s；识别结果只在本页展示，不上传', 'On-device Mandarin, short speech ≤60s; results stay on this page and are never uploaded'))
            .fontSize(11)
            .fontColor(Design.TEXT_HINT(this.uiDark))
            .width('100%')
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')

        Button(this.running ? I18n.t('停止测试', 'Stop test') : I18n.t('开始 60 秒测试', 'Start 60s test'))
          .fontSize(15)
          .height(44)
          .width('100%')
          .backgroundColor(this.running ? Design.DANGER : this.accent())
          .onClick(() => {
            this.toggleTest()
          })

        // 辅助操作：复制日志 / 清空 / 重新请求权限（对齐 Web 端 ASR 面板）
        Row({ space: 8 }) {
          this.assistChip(I18n.t('复制日志', 'Copy log'), () => {
            this.copyLog()
          })
          this.assistChip(I18n.t('清空', 'Clear'), () => {
            AsrTestService.clearEvents()
            this.copyNote = ''
          })
          this.assistChip(I18n.t('重新授权', 'Re-grant'), () => {
            this.reRequestPermission()
          })
        }
        .width('100%')

        if (this.copyNote.length > 0) {
          Text(this.copyNote)
            .fontSize(11)
            .fontColor(Design.TEXT_HINT(this.uiDark))
            .width('100%')
        }

        if (this.summaryText.length > 0) {
          Text(this.summaryText)
            .fontSize(13)
            .fontColor(Design.SUCCESS)
            .width('100%')
        }

        // 事件流日志
        Column({ space: 2 }) {
          if (this.events.length === 0) {
            Text(I18n.t('事件流为空，点击上方按钮开始测试', 'No events yet; tap the button above to start'))
              .fontSize(12)
              .fontColor(Design.TEXT_HINT(this.uiDark))
              .padding(12)
          } else {
            ForEach(this.events, (e: AsrEvent, idx: number) => {
              Text(this.eventLine(e))
                .fontSize(11)
                .fontColor(e.type === 'error' ? Design.DANGER :
                  (e.type === 'final' ? Design.SUCCESS : Design.TEXT_SUB(this.uiDark)))
                .width('100%')
                .padding({ left: 12, right: 12, top: 2, bottom: 2 })
            }, (e: AsrEvent, idx: number) => idx.toString() + ':' + e.type + ':' + e.atMs.toString())
          }
        }
        .width('100%')
        .backgroundColor(this.surface())
        .borderRadius(Design.RADIUS_CARD)
        .padding({ top: 8, bottom: 8 })
        .alignItems(HorizontalAlign.Start)
      }
      .padding(16)
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.pageBg())
  }
}
