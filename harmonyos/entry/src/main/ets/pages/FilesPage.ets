import { Theme, Design } from '../models/Theme'
import { AppState } from '../services/AppState'
import { GatewayApi } from '../services/GatewayApi'
import { FileExporter } from '../services/FileExporter'
import { FsEntry } from '../models/FsEntry'
import { FsUploadService } from '../services/FsUploadService'
import { I18n } from '../common/I18n'

/**
 * 文件页：目录浏览、下拉刷新、多根切换、文本预览（底部滑入面板）、
 * 另存为导出、新建文件夹、分块上传；反馈统一走 Toast，下载/上传防重。
 */
@Component
export struct FilesPage {
  @StorageLink('appState') appState: AppState = AppState.instance
  /** 深浅判定（AppState 写入）；变更驱动整页刷新 */
  @StorageLink('uiDark') uiDark: boolean = false
  /** 当前主题 id 原语（AppState 写入）；主题切换驱动整页刷新 */
  @StorageLink('uiTheme') uiTheme: string = 'deep-space'

  @State entries: FsEntry[] = []
  @State currentPath: string = ''
  @State roots: string[] = []
  @State loading: boolean = false
  @State refreshing: boolean = false
  @State fsError: string = ''
  /** 预览面板可见性；镜像到 AppStorage 供 Index.onBackPress 系统返回时优先关闭 */
  @StorageLink('filesPreviewVisible') previewVisible: boolean = false
  /** Index.onBackPress 触发的"返回上级"信号（序号递增）；本页 @Watch 响应 */
  @StorageLink('filesNavUpSeq') @Watch('onNavUpSeq') filesNavUpSeq: number = 0
  @State previewName: string = ''
  @State previewContent: string = ''
  @State previewLoading: boolean = false
  @State previewError: string = ''
  @State downloading: boolean = false
  @State uploading: boolean = false
  @State uploadPercent: number = 0
  @State uploadMsg: string = ''
  /** 新建文件夹弹层 */
  @State showMkdirSheet: boolean = false
  @State mkdirName: string = ''
  @State mkdirBusy: boolean = false
  /** 列表行按压缩放反馈 */
  @State pressedPath: string = ''
  /** 刷新图标点击旋转角（每次 +360 转一圈） */
  @State spin: number = 0

  aboutToAppear(): void {
    this.loadList('')
  }

  /** Index.onBackPress 的"返回上级"信号：仅当本页正显示子目录时消费 */
  onNavUpSeq(): void {
    if (this.filesNavUpSeq > 0 && this.parentPath().length > 0) {
      this.loadList(this.parentPath())
    }
  }

  private toast(msg: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: msg, duration: 3000 })
    } catch (e) {
    }
  }

  private async startUpload(): Promise<void> {
    if (this.uploading) {
      this.toast(I18n.t('已有上传在进行中', 'An upload is already running'))
      return
    }
    const s = this.appState.server
    if (!s || s.token.length === 0) {
      this.toast(I18n.t('未连接服务器或未配置令牌', 'Server not connected or token missing'))
      return
    }
    const uri = await FsUploadService.pickFile()
    if (uri.length === 0) {
      return
    }
    const stat = await FsUploadService.statUri(uri)
    if (!stat) {
      this.toast(I18n.t('无法读取所选文件', 'Cannot read the selected file'))
      return
    }
    this.uploading = true
    this.uploadPercent = 0
    this.uploadMsg = I18n.t('上传到 ', 'Upload to ') + (this.currentPath.length > 0 ? this.currentPath : '~')
    FsUploadService.upload(s.normalizedUrl(), s.token, this.currentPath, uri,
      (percent: number) => {
        this.uploadPercent = percent
      },
      (ok: boolean, msg: string) => {
        this.uploading = false
        this.uploadMsg = ''
        if (ok) {
          this.toast(I18n.t('上传完成：', 'Upload finished: ') + msg)
          this.loadList(this.currentPath)
        } else {
          this.toast(I18n.t('上传失败：', 'Upload failed: ') + msg)
        }
      })
  }

  private async loadList(path: string): Promise<void> {
    const s = this.appState.server
    if (!s || s.token.length === 0) {
      this.fsError = I18n.t('未连接服务器或未配置令牌', 'Server not connected or token missing')
      return
    }
    this.loading = true
    this.fsError = ''
    try {
      const data = await GatewayApi.fsList(s.normalizedUrl(), s.token, path)
      this.currentPath = String(data['path'] ?? '')
      // 供 Index.onBackPress 判断文件页系统返回层级（是否还有上级目录）
      AppStorage.setOrCreate('filesPath', this.currentPath)
      AppStorage.setOrCreate('filesPathHasParent', this.inRoot())
      const rawRoots = data['roots'] as Array<Object> ?? []
      const rootList: string[] = []
      for (const r of rawRoots) {
        const v = String(r ?? '')
        if (v.length > 0) {
          rootList.push(v)
        }
      }
      this.roots = rootList
      const rawEntries = data['entries'] as Array<Record<string, Object>>
      const list: FsEntry[] = []
      if (rawEntries) {
        for (const e of rawEntries) {
          list.push(FsEntry.fromRecord(e))
        }
      }
      list.sort((a: FsEntry, b: FsEntry) => {
        if (a.isDir() !== b.isDir()) {
          return a.isDir() ? -1 : 1
        }
        return a.name < b.name ? -1 : 1
      })
      this.entries = list
    } catch (e) {
      const msg = I18n.t('加载失败：', 'Load failed: ') + (e as Error).message
      this.fsError = msg
      this.toast(msg)
    } finally {
      this.loading = false
    }
  }

  private parentPath(): string {
    const p = this.currentPath
    if (!p) {
      return ''
    }
    const sep = p.indexOf('\\') >= 0 ? '\\' : '/'
    const idx = p.lastIndexOf(sep)
    if (idx <= 0) {
      return ''
    }
    return p.substring(0, idx)
  }

  /** 当前路径是否严格处于某个授权根目录内部（决定能否返回上级；根目录本身没有上级） */
  private inRoot(): boolean {
    for (const r of this.roots) {
      if (r.length === 0) {
        continue
      }
      if (this.currentPath === r) {
        return false
      }
      if (this.currentPath.startsWith(r + '\\') || this.currentPath.startsWith(r + '/')) {
        return true
      }
    }
    return false
  }

  private async openEntry(entry: FsEntry): Promise<void> {
    if (entry.isDir()) {
      await this.loadList(entry.path)
      return
    }
    this.openPreview(entry)
  }

  private async openPreview(entry: FsEntry): Promise<void> {
    const s = this.appState.server
    if (!s) {
      return
    }
    this.previewName = entry.name
    this.previewContent = ''
    this.previewError = ''
    this.previewLoading = true
    this.previewVisible = true
    try {
      const data = await GatewayApi.fsPreview(s.normalizedUrl(), s.token, entry.path)
      this.previewContent = String(data['content'] ?? '')
      const ext = String(data['extension'] ?? '')
      if (this.previewContent.length === 0 && ext === '') {
        this.previewError = I18n.t('该文件不可预览', 'This file cannot be previewed')
      }
    } catch (e) {
      this.previewError = I18n.t('预览失败：', 'Preview failed: ') + (e as Error).message
    } finally {
      this.previewLoading = false
    }
  }

  /**
   * 下载（另存为）：拉取文件内容后弹系统「另存为」，
   * 由用户选择保存位置（对齐 Android 端 downloadToDownloads 的用户可发现性）。
   */
  private async downloadEntry(entry: FsEntry): Promise<void> {
    if (this.downloading) {
      this.toast(I18n.t('已有下载在进行中', 'A download is already running'))
      return
    }
    const s = this.appState.server
    if (!s || entry.isDir()) {
      return
    }
    this.downloading = true
    try {
      const buf = await GatewayApi.fsDownload(s.normalizedUrl(), s.token, entry.path)
      const uri = await FileExporter.saveBytes(buf, entry.name)
      if (uri.length === 0) {
        this.toast(I18n.t('已取消保存', 'Save cancelled'))
        return
      }
      this.toast(I18n.t('已保存：', 'Saved: ') + FileExporter.baseName(uri))
    } catch (e) {
      this.toast(I18n.t('下载失败：', 'Download failed: ') + (e as Error).message)
    } finally {
      this.downloading = false
    }
  }

  /** 打开新建文件夹弹层 */
  private openMkdir(): void {
    this.mkdirName = ''
    this.showMkdirSheet = true
  }

  /** 创建子目录（POST /fs/mkdir，对应 WebUI createWorkspace 的 mkdir 一步） */
  private async createFolder(): Promise<void> {
    const name = this.mkdirName.trim()
    if (name.length === 0 || this.mkdirBusy) {
      return
    }
    const s = this.appState.server
    if (!s) {
      return
    }
    this.mkdirBusy = true
    try {
      await GatewayApi.fsMkdir(s.normalizedUrl(), s.token, this.currentPath, name)
      this.showMkdirSheet = false
      this.mkdirName = ''
      this.toast(I18n.t('文件夹已创建', 'Folder created'))
      await this.loadList(this.currentPath)
    } catch (e) {
      const msg = (e as Error).message
      this.toast(msg === 'exists' ? I18n.t('同名目录已存在', 'Directory already exists') :
        msg === 'bad-name' ? I18n.t('名称不合法（不能含 \\ / : 等字符）', 'Invalid name (no \\ / : characters)') : I18n.t('创建失败：', 'Create failed: ') + msg)
    } finally {
      this.mkdirBusy = false
    }
  }

  private pageBg(): string {
    return Theme.bgOf(Theme.get(this.uiTheme), this.uiDark)
  }

  private accent(): string {
    return Theme.accentOf(Theme.get(this.uiTheme), this.uiDark)
  }

  private surface(): string {
    return Design.SURFACE(this.uiDark)
  }

  build() {
    Stack() {
      Column() {
        Row() {
          Text(I18n.t('文件', 'Files'))
            .fontSize(24)
            .fontWeight(FontWeight.Bold)
            .fontColor(Design.TEXT_MAIN(this.uiDark))
          Blank()
          Image($r('app.media.ic_add'))
            .width(21)
            .height(21)
            .fillColor(this.accent())
            .margin({ right: 14 })
            .onClick(() => {
              this.openMkdir()
            })
          Image($r('app.media.ic_upload'))
            .width(22)
            .height(22)
            .fillColor(Design.SUCCESS)
            .margin({ right: 14 })
            .onClick(() => {
              this.startUpload()
            })
          Image($r('app.media.ic_refresh'))
            .width(20)
            .height(20)
            .fillColor(this.loading ? Design.TEXT_HINT(this.uiDark) : this.accent())
            .rotate({ angle: this.spin })
            .animation({ duration: 550, curve: Curve.EaseInOut })
            .onClick(() => {
              this.spin += 360
              this.loadList(this.currentPath)
            })
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 12 + Design.safeTop(), bottom: 8 })

        // 上传进度（出现/收起带滑动淡入）
        if (this.uploading) {
          Column({ space: 6 }) {
            Row() {
              Text(this.uploadMsg)
                .fontSize(13)
                .fontColor(this.accent())
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .layoutWeight(1)
              Text(this.uploadPercent.toString() + '%')
                .fontSize(12)
                .fontColor(Design.TEXT_SUB(this.uiDark))
            }.width('100%')
            Progress({ value: this.uploadPercent, total: 100, type: ProgressType.Linear })
              .width('100%')
              .color(this.accent())
          }
          .width('100%')
          .padding({ left: 16, right: 16, bottom: 8 })
          .transition(TransitionEffect.OPACITY
            .combine(TransitionEffect.translate({ y: 24 }))
            .animation({ duration: 220, curve: Curve.Friction }))
        }

        // 多根切换
        if (this.roots.length > 1) {
          Scroll() {
            Row({ space: 8 }) {
              ForEach(this.roots, (root: string) => {
                Text(root.length > 0 ? root : '~')
                  .fontSize(12)
                  .fontColor(this.currentPath.startsWith(root) ? this.accent() : Design.TEXT_SUB(this.uiDark))
                  .padding({ left: 10, right: 10, top: 5, bottom: 5 })
                  .backgroundColor(this.currentPath.startsWith(root)
                    ? Design.chipBgStrong(this.accent()) : Design.SURFACE_SUB(this.uiDark))
                  .borderRadius(Design.RADIUS_PILL)
                  .animation({ duration: 180, curve: Curve.Smooth })
                  .onClick(() => {
                    this.loadList(root)
                  })
              }, (root: string) => root)
            }
            .padding({ left: 16, right: 16 })
          }
          .scrollable(ScrollDirection.Horizontal)
          .scrollBar(BarState.Off)
          .height(36)
        }

        // 路径栏（长按可复制路径；上级目录按钮在左，文件管理器惯例）
        Row() {
          if (this.inRoot()) {
            Row() {
              Image($r('app.media.ic_back'))
                .width(20)
                .height(20)
                .fillColor(this.accent())
            }
            .width(36)
            .height(36)
            .justifyContent(FlexAlign.Center)
            .margin({ left: -10 })
            .borderRadius(Design.RADIUS_PILL)
            .onClick(() => {
              this.loadList(this.parentPath())
            })
          }
          Text(this.currentPath.length > 0 ? this.currentPath : '~')
            .fontSize(13)
            .fontColor(Design.TEXT_SUB(this.uiDark))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
            .copyOption(CopyOptions.LocalDevice)
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 4, bottom: 4 })

        // 内容区：下拉刷新 + 列表/空态/加载态
        Refresh({ refreshing: $$this.refreshing }) {
          if (this.entries.length === 0 && !this.loading) {
            Column({ space: 8 }) {
              Text(this.fsError.length > 0 ? this.fsError : I18n.t('空目录', 'Empty directory'))
                .fontSize(14)
                .fontColor(Design.TEXT_SUB(this.uiDark))
                .textAlign(TextAlign.Center)
              Text(I18n.t('下拉可刷新', 'Pull down to refresh'))
                .fontSize(12)
                .fontColor(Design.TEXT_HINT(this.uiDark))
            }
            .width('100%')
            .height('100%')
            .padding({ left: 16, right: 16 })
            .justifyContent(FlexAlign.Center)
          } else if (this.entries.length === 0 && this.loading) {
            Column() {
              LoadingProgress()
                .width(28)
                .height(28)
                .color(Design.TEXT_HINT(this.uiDark))
            }
            .width('100%')
            .height('100%')
            .justifyContent(FlexAlign.Center)
          } else {
            List({ space: 6 }) {
              ForEach(this.entries, (entry: FsEntry) => {
                ListItem() {
                  Row() {
                    Image(entry.isDir() ? $r('app.media.ic_folder') : $r('app.media.ic_file'))
                      .width(20)
                      .height(20)
                      .fillColor(entry.isDir() ? this.accent() : Design.TEXT_SUB(this.uiDark))
                      .margin({ right: 6 })
                    Column({ space: 2 }) {
                      Text(entry.name)
                        .fontSize(15)
                        .fontColor(Design.TEXT_MAIN(this.uiDark))
                        .maxLines(1)
                        .textOverflow({ overflow: TextOverflow.Ellipsis })
                      Text(entry.isDir() ? I18n.t('目录', 'Folder') : entry.sizeLabel())
                        .fontSize(12)
                        .fontColor(Design.TEXT_HINT(this.uiDark))
                    }
                    .alignItems(HorizontalAlign.Start)
                    .layoutWeight(1)

                    if (!entry.isDir()) {
                      // Block：拦截冒泡，避免同时触发整行 onClick（会重复开预览）
                      Text(I18n.t('预览', 'Preview'))
                        .fontSize(13)
                        .fontColor(this.accent())
                        .padding({ left: 8, right: 8, top: 6, bottom: 6 })
                        .hitTestBehavior(HitTestMode.Block)
                        .onClick(() => {
                          this.openPreview(entry)
                        })
                      Text(I18n.t('下载', 'Save'))
                        .fontSize(13)
                        .fontColor(Design.SUCCESS)
                        .padding({ left: 8, right: 8, top: 6, bottom: 6 })
                        .hitTestBehavior(HitTestMode.Block)
                        .onClick(() => {
                          this.downloadEntry(entry)
                        })
                    } else {
                      Image($r('app.media.ic_arrow_right'))
                        .width(18)
                        .height(18)
                        .fillColor(Design.TEXT_HINT(this.uiDark))
                    }
                  }
                  .width('100%')
                  .padding(12)
                  .backgroundColor(this.surface())
                  .borderRadius(Design.RADIUS_CONTROL)
                  .scale({
                    x: this.pressedPath === entry.path ? Design.PRESS_SCALE : 1,
                    y: this.pressedPath === entry.path ? Design.PRESS_SCALE : 1
                  })
                  .animation({ duration: Design.PRESS_DURATION, curve: Curve.Smooth })
                  .onTouch((event: TouchEvent) => {
                    if (event.type === TouchType.Down) {
                      this.pressedPath = entry.path
                    } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
                      this.pressedPath = ''
                    }
                  })
                  .onClick(() => {
                    this.openEntry(entry)
                  })
                }
              }, (entry: FsEntry) => entry.path)
            }
            .width('100%')
            .height('100%')
            .padding({ left: 16, right: 16, bottom: 96 })
          }
        }
        .width('100%')
        .layoutWeight(1)
        .onRefreshing(() => {
          this.loadList(this.currentPath).then(() => {
            this.refreshing = false
          })
        })
      }
      .width('100%')
      .height('100%')
      .backgroundColor(this.pageBg())
      .bindSheet($$this.showMkdirSheet, this.mkdirSheet(), {
        height: 220,
        showClose: true,
        title: { title: I18n.t('新建文件夹', 'New folder') },
        backgroundColor: this.surface()
      })

      // 预览覆盖层：遮罩淡入淡出，面板自底部滑入滑出
      if (this.previewVisible) {
        Stack({ alignContent: Alignment.Bottom }) {
          Column()
            .width('100%')
            .height('100%')
            .backgroundColor(Design.scrim(this.uiDark))
            .transition(TransitionEffect.OPACITY.animation({ duration: 220, curve: Curve.EaseOut }))
            .onClick(() => {
              this.previewVisible = false
            })

          Column() {
            Row() {
              Text(this.previewName)
                .fontSize(16)
                .fontWeight(FontWeight.Bold)
                .fontColor(Design.TEXT_MAIN(this.uiDark))
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .layoutWeight(1)
              Text(I18n.t('关闭', 'Close'))
                .fontSize(14)
                .fontColor(this.accent())
                .padding({ left: 8, right: 8, top: 6, bottom: 6 })
                .onClick(() => {
                  this.previewVisible = false
                })
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 12, bottom: 8 })

            if (this.previewLoading) {
              Text(I18n.t('预览加载中…', 'Loading preview…'))
                .fontSize(13)
                .fontColor(Design.TEXT_SUB(this.uiDark))
                .width('100%')
                .padding(16)
            } else if (this.previewError.length > 0) {
              Text(this.previewError)
                .fontSize(13)
                .fontColor(Design.DANGER)
                .width('100%')
                .padding(16)
            } else {
              Scroll() {
                Text(this.previewContent)
                  .fontSize(13)
                  .fontColor(Design.TEXT_MAIN(this.uiDark))
                  .width('100%')
                  .padding({ left: 16, right: 16, top: 4, bottom: 16 })
                  .copyOption(CopyOptions.LocalDevice)
              }
              .layoutWeight(1)
              .scrollBar(BarState.Auto)
            }
          }
          .width('100%')
          .height('80%')
          .backgroundColor(this.surface())
          .borderRadius({ topLeft: 16, topRight: 16 })
          .transition(TransitionEffect.asymmetric(
            TransitionEffect.translate({ y: '100%' })
              .animation({ duration: 300, curve: Curve.Friction }),
            TransitionEffect.translate({ y: '100%' })
              .animation({ duration: 240, curve: Curve.EaseIn })
          ))
        }
        .width('100%')
        .height('100%')
      }
    }
    .width('100%')
    .height('100%')
  }

  /** 新建文件夹弹层：目录名输入 + 创建按钮 */
  @Builder
  mkdirSheet() {
    Column({ space: 12 }) {
      Text(I18n.t('在 ', 'Create under ') + (this.currentPath.length > 0 ? this.currentPath : '~'))
        .fontSize(12)
        .fontColor(Design.TEXT_HINT(this.uiDark))
        .width('100%')
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      TextInput({ text: $$this.mkdirName, placeholder: I18n.t('输入文件夹名称', 'Folder name') })
        .height(42)
        .fontSize(14)
      Button(this.mkdirBusy ? I18n.t('创建中…', 'Creating…') : I18n.t('创建', 'Create'))
        .fontSize(15)
        .height(44)
        .width('100%')
        .backgroundColor(this.accent())
        .enabled(!this.mkdirBusy)
        .onClick(() => {
          this.createFolder()
        })
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 8, bottom: 16 })
  }
}
