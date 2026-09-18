import { Theme, Design } from '../models/Theme'
import { AppState } from '../services/AppState'
import { GatewayApi } from '../services/GatewayApi'
import { FileExporter } from '../services/FileExporter'
import { FsEntry } from '../models/FsEntry'
import { Crumb } from '../models/Crumb'
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
  /** 预览目标完整路径（错误态下供"另存"复用） */
  @State previewPath: string = ''
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
  /** 排序方式：name=名称 / time=修改时间 / size=大小（目录始终优先，对齐服务端语义） */
  @State sortMode: string = 'name'
  /**
   * 目录切换方向（驱动列表过渡）：1=进入子目录（新列表自右入），
   * -1=返回上级（自左入），0=刷新/首次（无位移仅淡入）。key 变化触发重建。
   */
  @State navDir: number = 0
  /** 列表内容代数（诊断/未来扩展用；过渡靠 navDir 分支重建驱动） */
  @State listGen: number = 0

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
    // 方向判定：按路径深度差（进入更深 = 1，返回更浅 = -1，同深/未知 = 0）。
    // 目录切换（navDir != 0）时先清 entries：让渲染树先经历"空态分支"，
    // 数据到达后列表分支重新挂载，transition（方向性换页）才会重放——
    // 连续同级方向（navDir 不变）也要经这次重建才能再次触发动画
    if (path !== this.currentPath) {
      const targetDepth = path.split(/[\\/]/).filter((x: string) => x.length > 0).length
      const curDepth = this.currentPath.split(/[\\/]/).filter((x: string) => x.length > 0).length
      this.navDir = targetDepth > curDepth ? 1 : (targetDepth < curDepth ? -1 : 0)
    } else {
      this.navDir = 0
    }
    if (this.navDir !== 0) {
      this.entries = []
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
        if (this.sortMode === 'time') {
          return b.mtimeMs - a.mtimeMs
        }
        if (this.sortMode === 'size') {
          return b.size - a.size
        }
        return a.name < b.name ? -1 : 1
      })
      // 落新数据：列表分支重新挂载，包过渡容器的 transition 重放
      this.listGen += 1
      this.entries = list
    } catch (e) {
      const raw = (e as Error).message
      // 403/forbidden = 目标目录不在网关白名单（家目录/盘符根/工作区）内，
      // 典型场景：面包屑点了根以外的祖先段、或退上级退出了允许根。
      // 回退到最近的可用祖先目录（当前路径的上级逐级收窄到某个 root），
      // 而不是把用户晾在报错页；找不到可用祖先才显示错误。
      if (raw.indexOf('403') >= 0 || raw.toLowerCase().indexOf('forbidden') >= 0) {
        const fallback = this.nearestAllowedAncestor(path)
        if (fallback !== null) {
          await this.loadList(fallback)
          this.toast(I18n.t('该目录不在允许范围内，已返回最近的可访问目录', 'Outside allowed roots; returned to nearest accessible folder'))
          return
        }
      }
      const msg = I18n.t('加载失败：', 'Load failed: ') + raw
      this.fsError = msg
      this.toast(msg)
    } finally {
      this.loading = false
    }
  }

  /** 403 回退：从目标路径向上逐级找白名单根内的最近祖先；找不到返回 null */
  private nearestAllowedAncestor(path: string): string | null {
    if (path.length === 0) {
      return null
    }
    const sep = path.indexOf('\\') >= 0 ? '\\' : '/'
    let cur = path
    // 最多 8 级，防异常路径死循环
    for (let i = 0; i < 8; i++) {
      const idx = cur.lastIndexOf(sep)
      if (idx <= 0) {
        break
      }
      cur = cur.substring(0, idx)
      // 命中任一 root（含 root 自身，如 "D:\"）即为可用祖先；
      // root 的父级（盘符所在"计算机"层）无从到达，循环自然终止
      for (const r of this.roots) {
        if (cur === r || cur.startsWith(r.endsWith(sep) ? r : r + sep)) {
          return cur
        }
      }
    }
    // 逐级没命中：退回第一个 root 兜底（root 自身永远可列）
    return this.roots.length > 0 ? this.roots[0] : null
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
    // 对齐桌面端「点文件即打开」：可文本预览的进预览面板，其余直接另存
    if (entry.previewable()) {
      await this.openPreview(entry)
    } else {
      await this.downloadEntry(entry)
    }
  }

  /** 面包屑段：把当前路径按分隔符切成 {label, path} 序列（首段为根盘符/工作区名） */
  private crumbs(): Crumb[] {
    const out: Crumb[] = []
    const p = this.currentPath
    if (p.length === 0) {
      out.push(new Crumb('~', ''))
      return out
    }
    const sep = p.indexOf('\\') >= 0 ? '\\' : '/'
    const parts = p.split(sep).filter((s: string) => s.length > 0)
    let acc = ''
    if (p.startsWith(sep)) {
      acc = sep
      out.push(new Crumb('/', sep))
    }
    for (let i = 0; i < parts.length; i++) {
      acc = acc.length === 0 ? parts[i] : (acc.endsWith(sep) ? acc + parts[i] : acc + sep + parts[i])
      out.push(new Crumb(parts[i], acc))
    }
    return out
  }

  private async openPreview(entry: FsEntry): Promise<void> {
    const s = this.appState.server
    if (!s) {
      return
    }
    this.previewName = entry.name
    this.previewPath = entry.path
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
      const raw = (e as Error).message
      // 415/413/404 给出人话：类型不支持 / 文件过大 / 不存在（其余保持 HTTP 码）
      if (raw.indexOf('415') >= 0) {
        this.previewError = I18n.t('该文件类型不支持预览，可点击另存', 'Preview not supported for this type; save instead')
      } else if (raw.indexOf('413') >= 0) {
        this.previewError = I18n.t('文件过大（预览上限 1 MB），可点击另存', 'File too large (1 MB preview limit); save instead')
      } else if (raw.indexOf('404') >= 0) {
        this.previewError = I18n.t('文件不存在或已被移动', 'File not found')
      } else {
        this.previewError = I18n.t('预览失败：', 'Preview failed: ') + raw
      }
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

  /** 排序切换 chip（选中主色底） */
  @Builder
  sortChip(label: string, mode: string) {
    Text(label)
      .fontSize(12)
      .fontColor(this.sortMode === mode ? this.accent() : Design.TEXT_SUB(this.uiDark))
      .padding({ left: 10, right: 10, top: 5, bottom: 5 })
      .backgroundColor(this.sortMode === mode ? Design.chipBgStrong(this.accent()) : Design.SURFACE_SUB(this.uiDark))
      .borderRadius(Design.RADIUS_PILL)
      .animation({ curve: Design.motionCurve })
      .onClick(() => {
        if (this.sortMode !== mode) {
          this.sortMode = mode
          // 重排现有列表即可，不必重新拉取
          const sorted = [...this.entries]
          sorted.sort((a: FsEntry, b: FsEntry) => {
            if (a.isDir() !== b.isDir()) {
              return a.isDir() ? -1 : 1
            }
            if (mode === 'time') {
              return b.mtimeMs - a.mtimeMs
            }
            if (mode === 'size') {
              return b.size - a.size
            }
            return a.name < b.name ? -1 : 1
          })
          // 隐式动画包裹数组变更：key 稳定（path）时框架移动既有节点而非重建，
          // 位置变化按布局属性补间 → 行滑到新位置；弹簧曲线与全局布局动效一致
          this.getUIContext().animateTo({ curve: Design.motionCurve }, () => {
            this.entries = sorted
          })
        }
      })
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
            .animation({ curve: Design.motionCurve })
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
            .animation({ curve: Design.motionCurve }))
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
                  .animation({ curve: Design.motionCurve })
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

        // 路径栏（面包屑：每段可点跳转，末段高亮；上级按钮在左，文件管理器惯例）
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
          Scroll() {
            Row({ space: 2 }) {
              ForEach(this.crumbs(), (c: Crumb, idx: number) => {
                Text(c.label)
                  .fontSize(13)
                  .fontColor(idx === this.crumbs().length - 1 ? Design.TEXT_MAIN(this.uiDark) : this.accent())
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .constraintSize({ maxWidth: 160 })
                  .padding({ left: 4, right: 4, top: 6, bottom: 6 })
                  .borderRadius(Design.RADIUS_SMALL)
                  .onClick(() => {
                    if (idx < this.crumbs().length - 1) {
                      this.loadList(c.path)
                    }
                  })
                if (idx < this.crumbs().length - 1) {
                  Text('›')
                    .fontSize(13)
                    .fontColor(Design.TEXT_HINT(this.uiDark))
                }
              }, (c: Crumb) => c.path)
            }
          }
          .scrollable(ScrollDirection.Horizontal)
          .scrollBar(BarState.Off)
          .layoutWeight(1)
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 4, bottom: 4 })

        // 排序切换（目录始终优先，仅切换同级内规则）
        Row({ space: 8 }) {
          this.sortChip(I18n.t('按名称', 'By name'), 'name')
          this.sortChip(I18n.t('按时间', 'By time'), 'time')
          this.sortChip(I18n.t('按大小', 'By size'), 'size')
          Blank()
        }
        .width('100%')
        .padding({ left: 16, right: 16, bottom: 4 })

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
          } else if (this.navDir === 0) {
            // 刷新/首次加载：无方向语义，直接列表（无换页过渡，仅有布局动画）
            this.fileList()
          } else {
            // 目录切换：navDir 作 if 分支条件——分支切换必然销毁重建子树，
            // transition（进入自右轻滑入 24vp / 返回自左）确定性重放。
            // 注意 .opacity(1 - listGen*0) 这类"属性值恒定"的重建不可靠：
            // ArkUI 对属性值未变的节点不重建，transition 不会重放（真机实测）。
            if (this.navDir === 1) {
              Column() {
                this.fileList()
              }
              .width('100%')
              .height('100%')
              .transition(TransitionEffect.OPACITY
                .combine(TransitionEffect.translate({ x: 24 }))
                .animation({ curve: Design.motionCurve }))
            } else {
              Column() {
                this.fileList()
              }
              .width('100%')
              .height('100%')
              .transition(TransitionEffect.OPACITY
                .combine(TransitionEffect.translate({ x: -24 }))
                .animation({ curve: Design.motionCurve }))
            }
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
        // 居中弹窗（SheetType.CENTER）：平板 600-840vp 与 ≥840vp 宽度均支持；
        // 居中弹窗最小高度 320vp（官方规格），高度数值小于 320 会被抬到 320
        height: 320,
        preferType: SheetType.CENTER,
        showClose: true,
        title: { title: I18n.t('新建文件夹', 'New folder') },
        backgroundColor: this.surface(),
        dragBar: false
      })

      // 预览覆盖层：遮罩淡入淡出，面板自底部滑入滑出
      if (this.previewVisible) {
        Stack({ alignContent: Alignment.Bottom }) {
          Column()
            .width('100%')
            .height('100%')
            .backgroundColor(Design.scrim(this.uiDark))
            .transition(TransitionEffect.OPACITY.animation({ curve: Design.motionCurve }))
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
              Column({ space: 10 }) {
                Text(this.previewError)
                  .fontSize(13)
                  .fontColor(Design.DANGER)
                  .width('100%')
                // 失败态兜底动作：类型不支持/过大时直接另存，不用退出去点行
                Text(I18n.t('另存到手机', 'Save to device'))
                  .fontSize(13)
                  .fontColor(this.accent())
                  .padding({ left: 12, right: 12, top: 8, bottom: 8 })
                  .backgroundColor(Design.FILL_LIGHT(this.uiDark))
                  .borderRadius(Design.RADIUS_CONTROL)
                  .onClick(() => {
                    this.previewVisible = false
                    this.downloadEntry(new FsEntry('file', this.previewName, this.previewPath, 0, 0))
                  })
              }
              .width('100%')
              .alignItems(HorizontalAlign.Start)
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
          // 面板出场带跟随位移：入场自底部 64vp 滑入，退场滑回底部（原仅淡出）
          .transition(TransitionEffect.asymmetric(
            TransitionEffect.translate({ y: 64 })
              .combine(TransitionEffect.OPACITY)
              .animation({ curve: Design.motionCurve }),
            TransitionEffect.translate({ y: '100%' })
              .animation({ curve: Design.motionCurve })
          ))
        }
        .width('100%')
        .height('100%')
      }
    }
    .width('100%')
    .height('100%')
  }

  /** 文件列表主体（供内容区分支复用：刷新直挂 / 目录切换包过渡容器） */
  @Builder
  fileList() {
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
              Text(entry.isDir()
                ? I18n.t('目录', 'Folder')
                : entry.sizeLabel() + ' · ' + entry.mtimeLabel())
                .fontSize(12)
                .fontColor(Design.TEXT_HINT(this.uiDark))
                .maxLines(1)
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)

            if (!entry.isDir()) {
              // 行尾提示词：可预览的文件点行进预览，否则点行直接另存
              Text(entry.previewable()
                ? I18n.t('预览', 'Preview')
                : I18n.t('保存', 'Save'))
                .fontSize(13)
                .fontColor(entry.previewable() ? this.accent() : Design.SUCCESS)
                .padding({ left: 8, right: 4, top: 6, bottom: 6 })
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
          .animation({ curve: Design.pressCurve })
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

  /**
   * 新建文件夹弹层：目录位置说明 + 名称输入 + 创建按钮，紧凑单列。
   * sheet 高度 320：标题区(~64) + 内容(12+20+12+42+12+44+16) 刚好占满，
   * 避免旧 220 高度下内容顶头、底部大片空白的失衡排版。
   */
  @Builder
  mkdirSheet() {
    Column({ space: 12 }) {
      // 创建位置：图标 + 路径（等宽字号浅色，一眼看清建在哪）
      Row({ space: 6 }) {
        Image($r('app.media.ic_folder'))
          .width(16)
          .height(16)
          .fillColor(this.accent())
        Text(I18n.t('创建于 ', 'Create under ') + (this.currentPath.length > 0 ? this.currentPath : '~'))
          .fontSize(12)
          .fontColor(Design.TEXT_SUB(this.uiDark))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 10, right: 10, top: 8, bottom: 8 })
      .backgroundColor(Design.SURFACE_SUB(this.uiDark))
      .borderRadius(Design.RADIUS_SMALL)

      TextInput({ text: $$this.mkdirName, placeholder: I18n.t('输入文件夹名称', 'Folder name') })
        .height(44)
        .fontSize(15)
        .fontColor(Design.TEXT_MAIN(this.uiDark))
        .placeholderColor(Design.TEXT_HINT(this.uiDark))
        .backgroundColor(Design.FILL_LIGHT(this.uiDark))
        .borderRadius(Design.RADIUS_CONTROL)

      Button(this.mkdirBusy ? I18n.t('创建中…', 'Creating…') : I18n.t('创建', 'Create'))
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .height(44)
        .width('100%')
        .backgroundColor(this.accent())
        .fontColor(Color.White)
        .borderRadius(Design.RADIUS_CONTROL)
        .enabled(!this.mkdirBusy)
        .onClick(() => {
          this.createFolder()
        })
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 12, bottom: 16 })
  }
}
