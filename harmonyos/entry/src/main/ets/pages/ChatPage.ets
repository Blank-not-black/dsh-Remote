import { router } from '@kit.ArkUI'
import { cameraPicker, camera } from '@kit.CameraKit'
import { Theme, Design } from '../models/Theme'
import { image } from '@kit.ImageKit'
import { IBestButton } from '@ibestservices/ibest-ui-v2'
import { fileIo as fs, picker } from '@kit.CoreFileKit'
import { util } from '@kit.ArkTS'
import { AppState } from '../services/AppState'
import { GatewayApi } from '../services/GatewayApi'
import { FileExporter } from '../services/FileExporter'
import { ImageDecoder } from '../services/ImageDecoder'
import { SessionView } from '../models/SessionView'
import { ChatMessage } from '../models/ChatMessage'
import { PendingApproval, PendingQuestion } from '../models/PendingItem'
import {
  SessionHistoryPayload, SessionPromptPayload, TextBlock, ImageBlock, AnswerItem,
  SessionModelsPayload, SelectModelPayload, SessionCancelPayload
} from '../models/RpcPayloads'
import { ModelGroup, ModelEntry, CurrentModel, EffortOption } from '../models/ModelInfo'
import { MarkdownView } from '../components/MarkdownView'
import { I18n } from '../common/I18n'

/**
 * 提问选项选择状态（每题一份）。
 */
class ChoiceState {
  qIndex: number
  selected: string[]
  custom: string

  constructor(qIndex: number, selected: string[], custom: string) {
    this.qIndex = qIndex
    this.selected = selected
    this.custom = custom
  }
}

/** 已解码的消息图片（按消息 seq + 图索引定位） */
class DecodedImage {
  seq: number
  index: number
  pixelMap: image.PixelMap

  constructor(seq: number, index: number, pixelMap: image.PixelMap) {
    this.seq = seq
    this.index = index
    this.pixelMap = pixelMap
  }
}

/** 待发送的图片附件 */
class AttachmentItem {
  name: string
  mediaType: string
  data: string

  constructor(name: string, mediaType: string, data: string) {
    this.name = name
    this.mediaType = mediaType
    this.data = data
  }
}

/**
 * 会话详情：历史消息、实时回复、发送、审批/提问处理。
 * 会话事件经 AppState.chatSink 回调实时追加。
 */
@Entry
@Component
struct ChatPage {
  @StorageLink('appState') appState: AppState = AppState.instance
  /** 深浅判定（AppState 写入）；变更驱动整页刷新 */
  @StorageLink('uiDark') uiDark: boolean = false
  /** 当前主题 id 原语（AppState 写入）；主题切换驱动整页刷新 */
  @StorageLink('uiTheme') uiTheme: string = 'deep-space'

  @State messages: ChatMessage[] = []
  @State title: string = I18n.t('会话', 'Session')
  @State running: boolean = false
  @State inputText: string = ''
  @State sending: boolean = false
  @State showPending: boolean = false
  @State choiceStates: ChoiceState[] = []
  @State pendingNote: string = ''
  @State modelGroups: ModelGroup[] = []
  @State currentModel: CurrentModel | null = null
  @State showModels: boolean = false
  @State decodedImages: DecodedImage[] = []
  @State attachments: AttachmentItem[] = []
  @State streamText: string = ''
  @State streamActive: boolean = false
  /** 已展开思考过程的 assistant 消息 seq */
  @State expandedReasoning: number[] = []
  /** 重命名弹层 */
  @State showRename: boolean = false
  @State renameText: string = ''
  /** 输入栏加号/斜杠命令菜单 */
  @State showPlusMenu: boolean = false
  /** 当前展开的压缩摘要条 seq（-1 = 全部折叠） */
  @State expandedCompaction: number = -1
  /** 会话投影快照（goal/todos/sessionStats，AppState 推送 + session.list 初值） */
  @State projValues: Record<string, Object> = {}
  private sessionId: string = ''
  private scroller: Scroller = new Scroller()

  aboutToAppear(): void {
    const params = router.getParams() as Record<string, Object>
    this.sessionId = String(params?.['sessionId'] ?? '')
    if (this.sessionId.length === 0) {
      return
    }
    this.appState.activeSessionId = this.sessionId
    this.appState.chatSink = (ev: Record<string, Object>) => {
      this.onChatEvent(ev)
    }
    // 投影卡片：先取缓存初值，再注册增量回调
    this.projValues = this.appState.projectionOf(this.sessionId)
    this.appState.projectionSink = (values: Record<string, Object>) => {
      this.projValues = values
    }
    this.resolveTitle()
    this.loadHistory()
  }

  /**
   * 系统返回（返回键/侧滑手势）：按 z 序先关最上层的自定义覆盖层，
   * 全关后才回上一页。bindSheet 弹层由系统处理，不在此列。
   */
  onBackPress(): boolean {
    if (this.showRename) {
      this.showRename = false
      return true
    }
    if (this.showModels) {
      this.showModels = false
      return true
    }
    if (this.showPending) {
      this.showPending = false
      return true
    }
    if (this.showPlusMenu) {
      this.showPlusMenu = false
      return true
    }
    return false
  }

  aboutToDisappear(): void {
    // 与 WebUI closeSession 对齐：离开时若会话仍为空（无任何消息且无待处理），
    // 从本地列表移除，避免“新建后没发一句话”的空会话堆积。
    if (this.appState.activeSessionId === this.sessionId) {
      this.appState.activeSessionId = ''
      this.appState.chatSink = null
      this.appState.projectionSink = null
    }
    if (this.sessionId.length > 0) {
      this.appState.discardEmptySession(this.sessionId)
    }
  }

  /** 打开重命名弹层，预填当前标题 */
  private openRename(): void {
    const s = this.findSession()
    this.renameText = s ? s.title.trim() : ''
    this.showRename = true
  }

  private findSession(): SessionView | null {
    for (const s of this.appState.sessions) {
      if (s.sessionId === this.sessionId) {
        return s
      }
    }
    return null
  }

  /** 提交重命名 */
  private async submitRename(): Promise<void> {
    const title = this.renameText.trim()
    if (title.length === 0) {
      this.pendingNote = I18n.t('标题不能为空', 'Title cannot be empty')
      return
    }
    const ok = await this.appState.renameSession(this.sessionId, title)
    if (ok) {
      this.showRename = false
      this.title = title
      this.pendingNote = ''
    } else {
      this.pendingNote = I18n.t('重命名失败', 'Rename failed')
    }
  }

  private resolveTitle(): void {
    for (const s of this.appState.sessions) {
      if (s.sessionId === this.sessionId) {
        this.title = s.displayTitle()
        this.running = s.running
        return
      }
    }
  }

  private async loadHistory(): Promise<void> {
    const s = this.appState.server
    if (!s || this.sessionId.length === 0) {
      return
    }
    try {
      const payload: SessionHistoryPayload = { sessionId: this.sessionId, maxMessages: 60 }
      const v = await GatewayApi.rpc(s.normalizedUrl(), s.token, 'session.history', payload)
      const vv = v as Record<string, Object>
      const events = vv['events'] as Array<Record<string, Object>>
      const list: ChatMessage[] = []
      if (events) {
        for (const entry of events) {
          const ev = entry['event'] as Record<string, Object>
          if (ev) {
            const m = ChatMessage.fromEvent(ev)
            if (m) {
              list.push(m)
            }
          }
        }
      }
      list.sort((a: ChatMessage, b: ChatMessage) => a.seq - b.seq)
      this.messages = list
      for (const m of list) {
        this.decodeImages(m)
      }
      this.scroller.scrollEdge(Edge.Bottom)
    } catch (e) {
      this.pendingNote = I18n.t('历史加载失败：', 'History load failed: ') + (e as Error).message
    }
  }

  private onChatEvent(ev: Record<string, Object>): void {
    const type = String(ev['type'] ?? '')
    if (type === 'session/reasoning') {
      this.handleReasoningBaseline(ev)
      return
    }
    if (type === 'assistant/chunk') {
      this.handleStreamChunk(ev)
      this.scroller.scrollEdge(Edge.Bottom)
      return
    }
    if (type === 'assistant/message' || type === 'turn/end') {
      this.streamActive = false
      this.streamText = ''
    }
    if (String(ev['type'] ?? '') === 'agent/status') {
      const data = ev['data'] as Record<string, Object> ?? {}
      this.running = data['running'] as boolean ?? false
      if (!this.running) {
        this.streamActive = false
      }
    }
    const m = ChatMessage.fromEvent(ev)
    if (m) {
      this.messages = [...this.messages, m]
      this.decodeImages(m)
      this.scroller.scrollEdge(Edge.Bottom)
    }
    this.resolveTitle()
  }

  /**
   * 思考基线（v0.6.26 网关新事件 session/reasoning）：晚加入/重连/切后台回来时，
   * 网关用 partialReasoning（聚合好的思考块数组）重放当前流式进度，
   * 对齐 Web 端 applyReasoningBaseline——直接替换本地 streamText，不与增量叠加。
   */
  private handleReasoningBaseline(ev: Record<string, Object>): void {
    const raw = ev['partialReasoning'] as Array<Record<string, Object>> ?? []
    let text = ''
    for (const item of raw) {
      const t = String(item['text'] ?? '')
      if (t.length > 0) {
        text += t + '\n\n'
      }
    }
    if (text.length > 0) {
      this.streamText = text.trimEnd()
      this.streamActive = true
      this.scroller.scrollEdge(Edge.Bottom)
    }
  }

  /** 流式思考块聚合：assistant/chunk → streamText */
  private handleStreamChunk(ev: Record<string, Object>): void {
    const data = ev['data'] as Record<string, Object> ?? {}
    const chunk = data['chunk'] as Record<string, Object> ?? {}
    const type = String(chunk['type'] ?? '')
    if (type === 'block-start') {
      this.streamActive = true
      return
    }
    if (type === 'reasoning-delta') {
      const text = String(chunk['text'] ?? '')
      if (text.length > 0) {
        this.streamText += text
        this.streamActive = true
      }
      return
    }
    if (type === 'block-end') {
      const block = chunk['block'] as Record<string, Object>
      if (block) {
        const finalText = String(block['text'] ?? block['content'] ?? '')
        if (finalText.length > 0) {
          this.streamText = finalText
          this.streamActive = true
        }
      }
    }
  }

  private async send(): Promise<void> {
    const text = this.inputText.trim()
    if ((text.length === 0 && this.attachments.length === 0) || this.sending) {
      return
    }
    const s = this.appState.server
    if (!s) {
      this.pendingNote = I18n.t('未连接服务器', 'Server not connected')
      return
    }
    this.sending = true
    try {
      // 纯文本斜杠命令优先（compact/export 不回退文本发送）
      if (this.attachments.length === 0 && text.startsWith('/')) {
        const handled = await this.trySlashCommand(text)
        if (handled) {
          this.inputText = ''
          return
        }
      }
      const content: Array<TextBlock | ImageBlock> = []
      for (const att of this.attachments) {
        const block: ImageBlock = { type: 'image', mediaType: att.mediaType, data: att.data, name: att.name }
        content.push(block)
      }
      if (text.length > 0) {
        const tb: TextBlock = { type: 'text', text: text }
        content.push(tb)
      }
      const payload: SessionPromptPayload = { sessionId: this.sessionId, mode: 'queue', content: content }
      await GatewayApi.rpc(s.normalizedUrl(), s.token, 'session.prompt', payload)
      // 不乐观插入：等待实时事件回显（与 Web 端一致）
      this.inputText = ''
      this.attachments = []
      this.scroller.scrollEdge(Edge.Bottom)
    } catch (e) {
      this.pendingNote = I18n.t('发送失败：', 'Send failed: ') + (e as Error).message
    } finally {
      this.sending = false
    }
  }

  /** 拍照发图：拉起系统相机（CameraPicker），拍完即读入附件（对齐 Web 端 composer 相机入口） */
  private async takePhoto(): Promise<void> {
    try {
      const profile: cameraPicker.PickerProfile = {
        cameraPosition: camera.CameraPosition.CAMERA_POSITION_BACK
      }
      const result = await cameraPicker.pick(getContext(this),
        [cameraPicker.PickerMediaType.PHOTO], profile)
      if (result.resultCode === 0 && result.resultUri.length > 0) {
        await this.readImage(result.resultUri)
      }
    } catch (e) {
      this.pendingNote = I18n.t('拍照失败：', 'Camera failed: ') + (e as Error).message
    }
  }

  private async pickImages(): Promise<void> {
    try {
      const photoPicker = new picker.PhotoViewPicker()
      const opts = new picker.PhotoSelectOptions()
      opts.MIMEType = picker.PhotoViewMIMETypes.IMAGE_TYPE
      opts.maxSelectNumber = 3
      const result = await photoPicker.select(opts)
      for (const uri of result.photoUris) {
        this.readImage(uri)
      }
    } catch (e) {
      this.pendingNote = I18n.t('选择图片失败', 'Failed to pick images')
    }
  }

  private async readImage(uri: string): Promise<void> {
    try {
      const file = fs.openSync(uri, fs.OpenMode.READ_ONLY)
      const stat = fs.statSync(file.fd)
      const buf = new ArrayBuffer(stat.size)
      const read = fs.readSync(file.fd, buf)
      fs.closeSync(file)
      if (read <= 0) {
        return
      }
      const helper = new util.Base64Helper()
      const data = helper.encodeToStringSync(new Uint8Array(buf, 0, read))
      const slash = uri.lastIndexOf('/')
      const rawName = slash >= 0 ? uri.substring(slash + 1) : uri
      const dot = rawName.lastIndexOf('.')
      const ext = dot >= 0 ? rawName.substring(dot + 1).toLowerCase() : ''
      let mime: string = 'image/jpeg'
      if (ext === 'png') {
        mime = 'image/png'
      } else if (ext === 'webp') {
        mime = 'image/webp'
      } else if (ext === 'gif') {
        mime = 'image/gif'
      }
      this.attachments = [...this.attachments, new AttachmentItem(rawName, mime, data)]
    } catch (e) {
      this.pendingNote = I18n.t('图片读取失败：', 'Image read failed: ') + (e as Error).message
    }
  }

  private removeAttachment(index: number): void {
    const next: AttachmentItem[] = []
    for (let i = 0; i < this.attachments.length; i++) {
      if (i !== index) {
        next.push(this.attachments[i])
      }
    }
    this.attachments = next
  }

  private currentApprovals(): PendingApproval[] {
    const out: PendingApproval[] = []
    for (const a of this.appState.pendingApprovals) {
      if (a.sessionId === this.sessionId) {
        out.push(a)
      }
    }
    return out
  }

  private currentQuestions(): PendingQuestion[] {
    const out: PendingQuestion[] = []
    for (const q of this.appState.pendingQuestions) {
      if (q.sessionId === this.sessionId) {
        out.push(q)
      }
    }
    return out
  }

  private pendingTotal(): number {
    return this.currentApprovals().length + this.currentQuestions().length
  }

  private openPending(): void {
    const qs = this.currentQuestions()
    const states: ChoiceState[] = []
    for (let i = 0; i < qs.length; i++) {
      states.push(new ChoiceState(i, [], ''))
    }
    this.choiceStates = states
    this.pendingNote = ''
    this.showPending = true
  }

  private choiceAt(qIndex: number): ChoiceState {
    for (const st of this.choiceStates) {
      if (st.qIndex === qIndex) {
        return st
      }
    }
    return new ChoiceState(qIndex, [], '')
  }

  private isSelected(qIndex: number, label: string): boolean {
    const st = this.choiceAt(qIndex)
    return st.selected.indexOf(label) >= 0
  }

  private toggleChoice(qIndex: number, label: string): void {
    const st = this.choiceAt(qIndex)
    const sel: string[] = []
    let found: boolean = false
    for (const v of st.selected) {
      if (v === label) {
        found = true
      } else {
        sel.push(v)
      }
    }
    if (!found) {
      sel.push(label)
    }
    const next: ChoiceState[] = []
    for (const cur of this.choiceStates) {
      if (cur.qIndex === qIndex) {
        next.push(new ChoiceState(qIndex, sel, cur.custom))
      } else {
        next.push(cur)
      }
    }
    this.choiceStates = next
  }

  private setCustom(qIndex: number, value: string): void {
    const st = this.choiceAt(qIndex)
    const next: ChoiceState[] = []
    for (const cur of this.choiceStates) {
      if (cur.qIndex === qIndex) {
        next.push(new ChoiceState(qIndex, cur.selected, value))
      } else {
        next.push(cur)
      }
    }
    this.choiceStates = next
  }

  private async submitAnswers(rpcId: string): Promise<void> {
    let target: PendingQuestion | null = null
    for (const q of this.currentQuestions()) {
      if (q.rpcId === rpcId) {
        target = q
        break
      }
    }
    if (!target) {
      return
    }
    const answers: Array<AnswerItem> = []
    const list = target.questions
    for (let i = 0; i < list.length; i++) {
      const item = list[i]
      const id = String(item['id'] ?? 'q' + i.toString())
      const st = this.choiceAt(i)
      const ans: AnswerItem = { id: id, selected: st.selected }
      if (st.custom.length > 0) {
        ans.custom = st.custom
      }
      if (st.selected.length === 0 && st.custom.length === 0) {
        continue
      }
      answers.push(ans)
    }
    if (answers.length === 0) {
      this.pendingNote = I18n.t('请至少回答一道题', 'Answer at least one question')
      return
    }
    const ok = await this.appState.answerQuestion(rpcId, answers)
    this.pendingNote = ok ? I18n.t('已回答', 'Answered') : I18n.t('提交失败', 'Submit failed')
    if (ok) {
      this.showPending = false
    }
  }

  /**
   * 会话导出：GET /api/session.export（含子代理会话）→ 系统「另存为」落盘。
   * 文件名规则与 WebUI sessionLogFilename 一致。
   */
  private async exportSession(): Promise<void> {
    const s = this.appState.server
    if (!s) {
      this.pendingNote = I18n.t('未连接服务器', 'Server not connected')
      return
    }
    this.pendingNote = I18n.t('正在导出会话日志…', 'Exporting session log…')
    try {
      const buf = await GatewayApi.sessionExport(s.normalizedUrl(), s.token, this.sessionId)
      const safeId = this.sessionId.replace(/[^A-Za-z0-9_-]/g, '_')
      const name = 'dsh-session-' + safeId + '.zip'
      const uri = await FileExporter.saveBytes(buf, name)
      if (uri.length === 0) {
        this.pendingNote = ''
        return
      }
      this.pendingNote = I18n.t('已导出：', 'Exported: ') + FileExporter.baseName(uri)
    } catch (e) {
      this.pendingNote = I18n.t('导出失败：', 'Export failed: ') + (e as Error).message
    }
  }

  private async trySlashCommand(line: string): Promise<boolean> {
    const trimmed = line.replace(/^\/+/, '')
    const first = trimmed.split(' ')[0].split('/')[0]
    const command = first.toLowerCase()
    if (command === 'export') {
      this.exportSession()
      return true
    }
    const s = this.appState.server
    if (!s) {
      return false
    }
    try {
      const v = await GatewayApi.slashCommand(s.normalizedUrl(), s.token, this.sessionId, line)
      const vv = v as Record<string, Object>
      if (vv['ok'] === false) {
        this.pendingNote = String(vv['message'] ?? I18n.t('命令执行失败', 'Command failed'))
        return true
      }
      if (vv['ok'] === true && vv['executed'] === true) {
        this.pendingNote = vv['accepted'] === true ? I18n.t('命令已提交', 'Command queued') : I18n.t('命令已执行', 'Command executed')
        return true
      }
      return false
    } catch (e) {
      if (command === 'compact') {
        this.pendingNote = I18n.t('命令执行失败（不回退文本发送）', 'Command failed (not sent as text)')
        return true
      }
      return false
    }
  }

  private async loadModels(): Promise<void> {
    const s = this.appState.server
    if (!s || this.sessionId.length === 0) {
      return
    }
    try {
      const payload: SessionModelsPayload = { sessionId: this.sessionId }
      const v = await GatewayApi.rpc(s.normalizedUrl(), s.token, 'session.models', payload)
      const vv = v as Record<string, Object>
      const rawGroups = vv['groups'] as Array<Record<string, Object>> ?? []
      const groups: ModelGroup[] = []
      for (const g of rawGroups) {
        groups.push(ModelGroup.fromRecord(g))
      }
      this.modelGroups = groups
      const rawCurrent = vv['current'] as Record<string, Object> ?? {}
      this.currentModel = CurrentModel.fromRecord(rawCurrent)
    } catch (e) {
      this.pendingNote = I18n.t('模型加载失败', 'Model load failed')
    }
  }

  private findModel(provider: string, modelId: string): ModelEntry | null {
    for (const g of this.modelGroups) {
      if (g.id !== provider) {
        continue
      }
      for (const m of g.models) {
        if (m.id === modelId) {
          return m
        }
      }
    }
    return null
  }

  private currentModelEntry(): ModelEntry | null {
    const cur = this.currentModel
    if (!cur) {
      return null
    }
    return this.findModel(cur.provider, cur.model)
  }

  private isCurrentModel(provider: string, modelId: string): boolean {
    const cur = this.currentModel
    if (!cur) {
      return false
    }
    return cur.provider === provider && cur.model === modelId
  }

  private async selectModel(provider: string, modelId: string): Promise<void> {
    const s = this.appState.server
    if (!s) {
      return
    }
    const model = this.findModel(provider, modelId)
    const payload: SelectModelPayload = { sessionId: this.sessionId, provider: provider, model: modelId }
    if (model && model.defaultEffort.length > 0) {
      payload.reasoningEffort = model.defaultEffort
    }
    try {
      const v = await GatewayApi.rpc(s.normalizedUrl(), s.token, 'session.selectModel', payload)
      const vv = v as Record<string, Object>
      const sel = vv['selected'] as Record<string, Object>
      if (sel) {
        this.currentModel = CurrentModel.fromRecord(sel)
      }
    } catch (e) {
      this.pendingNote = I18n.t('切换模型失败：', 'Model switch failed: ') + (e as Error).message
    }
  }

  private async selectEffort(effortId: string): Promise<void> {
    const s = this.appState.server
    const cur = this.currentModel
    if (!s || !cur) {
      return
    }
    const payload: SelectModelPayload = {
      sessionId: this.sessionId,
      provider: cur.provider,
      model: cur.model,
      reasoningEffort: effortId
    }
    try {
      const v = await GatewayApi.rpc(s.normalizedUrl(), s.token, 'session.selectModel', payload)
      const vv = v as Record<string, Object>
      const sel = vv['selected'] as Record<string, Object>
      if (sel) {
        this.currentModel = CurrentModel.fromRecord(sel)
      }
    } catch (e) {
      this.pendingNote = I18n.t('切换档位失败：', 'Effort switch failed: ') + (e as Error).message
    }
  }

  private pageBg(): string {
    return Theme.bgOf(Theme.get(this.uiTheme), this.uiDark)
  }

  /**
   * 斜杠命令清单（与 WebUI composer 菜单对齐，permission 的子预设让用户补参数）。
   * cmd 填入输入框，desc 展示说明。
   */
  private slashCommands(): string[][] {
    return [
      ['/compact', I18n.t('压缩对话历史', 'Compact conversation history')],
      ['/export', I18n.t('导出会话日志 ZIP', 'Export session log ZIP')],
      ['/feedback', I18n.t('反馈当前会话', 'Give feedback on this session')],
      ['/goal', I18n.t('设置/查看任务目标', 'Set / view the goal')],
      ['/permission', I18n.t('切换权限预设（allow_once / always / deny）', 'Switch permission preset (allow_once / always / deny)')],
      ['/plan', I18n.t('进入/退出计划模式', 'Enter / exit plan mode')]
    ]
  }

  /** 选中命令：填入输入框（含尾随空格）并收起菜单 */
  private applyCommand(cmd: string): void {
    this.inputText = cmd + ' '
    this.showPlusMenu = false
  }

  /** 输入栏上方菜单：拍照/相册 + 斜杠命令 */
  @Builder
  plusMenu() {
    Column() {
      Column({ space: 2 }) {
        Row({ space: 10 }) {
          Image($r('app.media.ic_picture'))
            .width(20)
            .height(20)
            .fillColor(Design.TEXT_MAIN(this.uiDark))
          Text(I18n.t('拍照发送', 'Take photo'))
            .fontSize(14)
            .fontColor(Design.TEXT_MAIN(this.uiDark))
        }
        .width('100%')
        .padding({ left: 14, right: 14, top: 11, bottom: 11 })
        .borderRadius(Design.RADIUS_CONTROL)
        .onClick(() => {
          this.showPlusMenu = false
          this.takePhoto()
        })

        Divider().color(Design.FILL_LIGHT(this.uiDark)).margin({ left: 14, right: 14 })

        Row({ space: 10 }) {
          Image($r('app.media.ic_picture'))
            .width(20)
            .height(20)
            .fillColor(Design.TEXT_MAIN(this.uiDark))
          Text(I18n.t('发送图片（相册）', 'Send image (gallery)'))
            .fontSize(14)
            .fontColor(Design.TEXT_MAIN(this.uiDark))
        }
        .width('100%')
        .padding({ left: 14, right: 14, top: 11, bottom: 11 })
        .borderRadius(Design.RADIUS_CONTROL)
        .onClick(() => {
          this.showPlusMenu = false
          this.pickImages()
        })

        Divider().color(Design.FILL_LIGHT(this.uiDark)).margin({ left: 14, right: 14 })

        ForEach(this.slashCommands(), (entry: string[]) => {
          Row({ space: 10 }) {
            Text(entry[0])
              .fontSize(14)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.accent())
              .constraintSize({ minWidth: 96 })
            Text(entry[1])
              .fontSize(12)
              .fontColor(Design.TEXT_SUB(this.uiDark))
              .layoutWeight(1)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .width('100%')
          .padding({ left: 14, right: 14, top: 10, bottom: 10 })
          .borderRadius(Design.RADIUS_CONTROL)
          .onClick(() => {
            this.applyCommand(entry[0])
          })
        }, (entry: string[]) => entry[0])
      }
      .width('100%')
      .padding(6)
      .backgroundColor(Design.SURFACE(this.uiDark))
      .borderRadius(Design.RADIUS_CARD)
      .shadow({
        radius: 20,
        color: Design.scrim(this.uiDark),
        offsetX: 0,
        offsetY: 4
      })
    }
    .width('100%')
    .padding({ left: Design.PAD_PAGE, right: Design.PAD_PAGE, bottom: 6 })
  }

  private accent(): string {
    return Theme.get(this.uiTheme).accent
  }

  /** 主色 8% 透明度底色（标签/选中态通用） */
  private chipBg(): string {
    return this.accent() + '14'
  }

  // ---------------- 会话投影卡片（goal/todos/统计） ----------------

  /** goal 值：投影里可能是 {goal:{...}} 或 goal 本身（对齐 Web 端 goalOf） */
  private goalOf(): Record<string, Object> | null {
    const p = this.projValues['goal'] as Record<string, Object> ?? null
    if (!p) {
      return null
    }
    const inner = p['goal'] as Record<string, Object> ?? null
    return inner ? inner : p
  }

  /** goal 是否终态（对齐 Web 端 phase 枚举 active|paused|blocked|complete） */
  private goalTerminal(): boolean {
    const g = this.goalOf()
    if (!g) {
      return true
    }
    const phase = String(g['phase'] ?? '')
    return phase === '' ? true : phase === 'complete' || phase === 'cleared'
  }

  /** goal.pause/resume/complete/clear（payload 与 Web 端 goalAction 一致：{sessionId, ref}） */
  private async goalActionRpc(method: string, ref: Record<string, Object>): Promise<void> {
    const s = this.appState.server
    if (!s) {
      return
    }
    try {
      const payload: Record<string, Object> = { 'sessionId': this.sessionId, 'ref': ref }
      await GatewayApi.rpc(s.normalizedUrl(), s.token, method, payload)
      this.pendingNote = I18n.t('操作已提交', 'Action submitted')
    } catch (e) {
      this.pendingNote = I18n.t('目标操作失败：', 'Goal action failed: ') + (e as Error).message
    }
  }

  private goalActionRpcWrapper(kind: string, goalId: string, revision: number): void {
    const ref: Record<string, Object> = { 'id': goalId, 'revision': revision }
    const method = kind === 'pause' ? 'goal.pause' : kind === 'resume' ? 'goal.resume'
      : kind === 'complete' ? 'goal.complete' : 'goal.clear'
    this.goalActionRpc(method, ref)
  }

  /** 会话卡片集合：goal 卡 + todos 卡 + 统计卡（仅在有数据时渲染） */
  @Builder
  sessionCards() {
    Column({ space: 10 }) {
      if (this.goalOf() !== null && !this.goalTerminal()) {
        this.goalCard()
      }
      if (this.todosItems().length > 0) {
        this.todoCard()
      }
      if (this.sessionStatsInfo() !== null) {
        this.statsCard()
      }
    }
    .width('100%')
  }

  @Builder
  goalCard() {
    Column({ space: 6 }) {
      Row({ space: 8 }) {
        Text(I18n.t('任务目标', 'Goal'))
          .fontSize(13)
          .fontWeight(FontWeight.Bold)
          .fontColor(Design.TEXT_MAIN(this.uiDark))
          .layoutWeight(1)
        Text('phase: ' + String(this.goalOf()!['phase'] ?? '?') +
          ' · rev ' + String(this.goalOf()!['revision'] ?? '?'))
          .fontSize(10)
          .fontColor(Design.TEXT_HINT(this.uiDark))
      }
      .width('100%')
      Text(String(this.goalOf()!['objective'] ?? ''))
        .fontSize(13)
        .fontColor(Design.TEXT_SUB(this.uiDark))
        .width('100%')
      Flex({ wrap: FlexWrap.Wrap }) {
        this.goalActionChip('pause', I18n.t('暂停', 'Pause'), true)
        this.goalActionChip('resume', I18n.t('恢复', 'Resume'), true)
        this.goalActionChip('complete', I18n.t('完成', 'Complete'), false)
        this.goalActionChip('clear', I18n.t('清除', 'Clear'), false)
      }
      .width('100%')
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding(12)
    .backgroundColor(this.chipBg())
    .borderRadius(Design.RADIUS_CARD)
  }

  @Builder
  goalActionChip(kind: string, label: string, silent: boolean) {
    Text(label)
      .fontSize(12)
      .fontColor(this.accent())
      .padding({ left: 10, right: 10, top: 4, bottom: 4 })
      .borderRadius(Design.RADIUS_PILL)
      .border({ width: 1, color: this.accent() })
      .margin({ right: 6, top: 2 })
      .onClick(() => {
        if (silent) {
          this.goalActionRpcWrapper(kind, String(this.goalOf()!['id'] ?? ''), Number(this.goalOf()!['revision'] ?? 0))
          return
        }
        const confirmText = kind === 'complete' ? I18n.t('确认将当前目标标记为完成？', 'Mark the current goal as complete?') : I18n.t('确认清除当前任务目标？', 'Clear the current goal?')
        AlertDialog.show({
          title: kind === 'complete' ? I18n.t('完成目标', 'Complete goal') : I18n.t('清除目标', 'Clear goal'),
          message: confirmText,
          primaryButton: { value: I18n.t('取消', 'Cancel'), action: () => { } },
          secondaryButton: {
            value: I18n.t('确定', 'Confirm'),
            action: () => {
              this.goalActionRpcWrapper(kind, String(this.goalOf()!['id'] ?? ''), Number(this.goalOf()!['revision'] ?? 0))
            }
          }
        })
      })
  }

  private todosItems(): Array<Record<string, Object>> {
    const p = this.projValues['todos'] as Record<string, Object> ?? null
    if (!p) {
      return []
    }
    const items = p['items'] as Array<Record<string, Object>>
    return items ?? []
  }

  @Builder
  todoCard() {
    Column({ space: 6 }) {
      Text(I18n.t('待办事项', 'Todos'))
        .fontSize(13)
        .fontWeight(FontWeight.Bold)
        .fontColor(Design.TEXT_MAIN(this.uiDark))
        .width('100%')
      ForEach(this.todosItems(), (t: Record<string, Object>) => {
        Row({ space: 6 }) {
          Text(String(t['status'] ?? 'pending'))
            .fontSize(10)
            .fontColor(String(t['status'] ?? '') === 'completed' ? Design.SUCCESS :
              (String(t['status'] ?? '') === 'in_progress' ? this.accent() : Design.TEXT_HINT(this.uiDark)))
            .padding({ left: 6, right: 6, top: 2, bottom: 2 })
            .borderRadius(Design.RADIUS_PILL)
            .backgroundColor(Design.FILL_LIGHT(this.uiDark))
          Text(String(t['content'] ?? ''))
            .fontSize(13)
            .fontColor(Design.TEXT_MAIN(this.uiDark))
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
      }, (t: Record<string, Object>) => String(t['content'] ?? '') + ':' + String(t['status'] ?? ''))
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding(12)
    .backgroundColor(Design.SURFACE(this.uiDark))
    .borderRadius(Design.RADIUS_CARD)
    .shadow(Design.cardShadow(this.uiDark))
  }

  /** sessionStats 投影（turns/steps/llmMs + tokenUsage + contextPressure） */
  private sessionStatsInfo(): Record<string, Object> | null {
    const st = this.projValues['sessionStats'] as Record<string, Object> ?? null
    return st
  }

  private usageInfo(): Record<string, Object> {
    return this.projValues['tokenUsage'] as Record<string, Object> ?? {}
  }

  private pressureInfo(): Record<string, Object> {
    return this.projValues['contextPressure'] as Record<string, Object> ?? {}
  }

  private formatTokens(n: number): string {
    if (n >= 1000000) {
      return (Math.round(n / 100000) / 10).toFixed(1) + 'M'
    }
    if (n >= 1000) {
      return (Math.round(n / 100) / 10).toFixed(1) + 'k'
    }
    return Math.round(n).toString()
  }

  private statRow(key: string, value: string): string {
    return key + '：' + value
  }

  @Builder
  statsCard() {
    Column({ space: 6 }) {
      Text(I18n.t('本轮统计', 'Turn stats'))
        .fontSize(13)
        .fontWeight(FontWeight.Bold)
        .fontColor(Design.TEXT_MAIN(this.uiDark))
        .width('100%')
      Text(this.statRow(I18n.t('轮次/步数', 'Turns / steps'), String(this.sessionStatsInfo()!['turns'] ?? '—') + ' / ' +
        String(this.sessionStatsInfo()!['steps'] ?? '—')))
        .fontSize(12)
        .fontColor(Design.TEXT_SUB(this.uiDark))
        .width('100%')
      Text(this.statRow(I18n.t('LLM 耗时', 'LLM time'), (Number(this.sessionStatsInfo()!['llmMs'] ?? 0) / 60000).toFixed(1) + I18n.t(' 分钟', ' min')))
        .fontSize(12)
        .fontColor(Design.TEXT_SUB(this.uiDark))
        .width('100%')
      Text(this.statRow(I18n.t('输出/缓存', 'Output / cache'), this.formatTokens(Number(this.usageInfo()['outputTokens'] ?? 0)) + ' / ' +
        this.formatTokens(Number(this.usageInfo()['cacheReadTokens'] ?? 0))))
        .fontSize(12)
        .fontColor(Design.TEXT_SUB(this.uiDark))
        .width('100%')
      Text(this.statRow(I18n.t('上下文压力', 'Context pressure'), this.formatTokens(Number(this.pressureInfo()['pressureTokens'] ?? 0)) + ' / ' +
        this.formatTokens(Number(this.pressureInfo()['contextWindow'] ?? 0))))
        .fontSize(12)
        .fontColor(Design.TEXT_SUB(this.uiDark))
        .width('100%')
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding(12)
    .backgroundColor(Design.SURFACE_SUB(this.uiDark))
    .borderRadius(Design.RADIUS_CARD)
  }

  build() {
    Stack() {
      Column() {
        // 顶栏（鸿蒙导航栏：白底 + 底部轻分割投影）
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
          Column({ space: 2 }) {
            Text(this.title + ' ✎')
              .fontSize(17)
              .fontWeight(FontWeight.Bold)
              .fontColor(Design.TEXT_MAIN(this.uiDark))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(this.running ? I18n.t('运行中', 'Running') : I18n.t('已停止', 'Stopped'))
              .fontSize(11)
              .fontColor(this.running ? Design.SUCCESS : Design.TEXT_HINT(this.uiDark))
          }
          .alignItems(HorizontalAlign.Start)
          .margin({ left: 8 })
          .layoutWeight(1)
          .onClick(() => {
            this.openRename()
          })

          if (this.running) {
            Text(I18n.t('停止', 'Stop'))
              .fontSize(12)
              .fontColor(Design.DANGER)
              .padding({ left: 10, right: 10, top: 4, bottom: 4 })
              .backgroundColor(Design.dangerBg())
              .borderRadius(Design.RADIUS_PILL)
              .margin({ right: 8 })
              .onClick(() => {
                this.confirmCancel()
              })
          }

          Text(I18n.t('模型', 'Model'))
            .fontSize(12)
            .fontColor(this.accent())
            .padding({ left: 10, right: 10, top: 4, bottom: 4 })
            .backgroundColor(this.chipBg())
            .borderRadius(Design.RADIUS_PILL)
            .onClick(() => {
              this.loadModels()
              this.showModels = true
            })

          if (this.pendingTotal() > 0) {
            Text(I18n.t('待处理 ', 'Pending ') + this.pendingTotal().toString())
              .fontSize(12)
              .fontColor(Design.WARNING)
              .padding({ left: 8, right: 8, top: 4, bottom: 4 })
              .backgroundColor(Design.warningBg())
              .borderRadius(Design.RADIUS_PILL)
              .onClick(() => {
                this.openPending()
              })
          }
        }
        .width('100%')
        .padding({ left: 12, right: 12, top: 10 + Design.safeTop(), bottom: 10 })
        .backgroundColor(Design.SURFACE(this.uiDark))
        .shadow({
          radius: 8,
          color: Design.borderHair(this.uiDark),
          offsetX: 0,
          offsetY: 2
        })

        // 消息列表（IM 惯例：屏幕边距 16，上下留白 16，消息间距 12）
        List({ space: 12, scroller: this.scroller }) {
          // 会话卡片（goal / todos / 统计，对齐 Web 端 session-cards）
          ListItem() {
            this.sessionCards()
          }
          .width('100%')

          ForEach(this.messages, (item: ChatMessage) => {
            ListItem() {
              this.messageRow(item)
            }
            .width('100%')
          }, (item: ChatMessage) => item.type + '-' + item.seq.toString())

          if (this.streamActive) {
            ListItem() {
              this.streamRow()
            }
          }
        }
        .width('100%')
        .layoutWeight(1)
        .padding({
          left: Design.PAD_PAGE,
          right: Design.PAD_PAGE,
          top: 16,
          bottom: 16
        })
        .backgroundColor(this.pageBg())

        if (this.pendingNote.length > 0) {
          Text(this.pendingNote)
            .fontSize(12)
            .fontColor(Design.DANGER)
            .width('100%')
            .padding({ left: 16, right: 16, bottom: 4 })
            .backgroundColor(this.pageBg())
        }

        // 输入栏
        Column() {
          if (this.showPlusMenu) {
            this.plusMenu()
          }

          if (this.attachments.length > 0) {
            Row({ space: 8 }) {
              ForEach(this.attachments, (att: AttachmentItem, idx: number) => {
                Row({ space: 4 }) {
                  Text(I18n.t('🖼 图片', '🖼 Image ') + (idx + 1).toString())
                    .fontSize(12)
                    .fontColor(this.accent())
                  Text('×')
                    .fontSize(14)
                    .fontColor(Design.DANGER)
                    .onClick(() => {
                      this.removeAttachment(idx)
                    })
                }
                .padding({ left: 8, right: 8, top: 4, bottom: 4 })
                .backgroundColor(Design.chipBg(this.accent()))
                .borderRadius(8)
              }, (att: AttachmentItem, idx: number) => idx.toString() + att.name)
            }
            .width('100%')
            .padding({ left: 8, bottom: 6 })
          }

          Row({ space: 8 }) {
            Image($r('app.media.ic_add'))
              .width(22)
              .height(22)
              .fillColor(this.accent())
              .padding(10)
              .onClick(() => {
                this.showPlusMenu = !this.showPlusMenu
              })
            TextInput({ text: $$this.inputText, placeholder: I18n.t('输入消息，/ 唤起命令…', 'Type a message; / for commands…') })
              .height(42)
              .fontSize(14)
              .layoutWeight(1)
              .onChange((v: string) => {
                // 输入 / 开头时弹出命令面板，便于选择
                this.showPlusMenu = v.startsWith('/')
              })
            IBestButton({
              text: this.sending ? I18n.t('发送中', 'Sending') : I18n.t('发送', 'Send'),
              color: this.accent(),
              loading: this.sending,
              disabled: this.sending,
              onBtnClick: () => {
                this.send()
              }
            })
            .height(42)
            .width(78)
          }
          .width('100%')
          .padding({ left: 8, right: 8, top: 8, bottom: 8 + Design.safeBottom() })
          .backgroundColor(Design.SURFACE(this.uiDark))
        }
        .width('100%')
        .backgroundColor(Design.SURFACE(this.uiDark))
      }
      .width('100%')
      .height('100%')

      // 待处理遮罩（审批 + 提问回答）
      if (this.showPending) {
        Column()
          .width('100%')
          .height('100%')
          .backgroundColor(Design.scrim(this.uiDark))
          .onClick(() => {
            this.showPending = false
          })

        Column() {
          Row() {
            Text(I18n.t('待处理', 'Pending'))
              .fontSize(18)
              .fontWeight(FontWeight.Bold)
            Blank()
            Text(I18n.t('关闭', 'Close'))
              .fontSize(14)
              .fontColor(this.accent())
              .onClick(() => {
                this.showPending = false
              })
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 12, bottom: 8 })

          Scroll() {
            Column({ space: 12 }) {
              ForEach(this.currentApprovals(), (a: PendingApproval) => {
                Column({ space: 8 }) {
                  Text(I18n.t('工具审批：', 'Tool approval: ') + a.toolName)
                    .fontSize(15)
                    .fontWeight(FontWeight.Medium)
                  if (a.summary.length > 0) {
                    Text(a.summary)
                      .fontSize(12)
                      .fontColor(Design.TEXT_SUB(this.uiDark))
                  }
                  Row({ space: 10 }) {
                    Button(I18n.t('允许', 'Allow'))
                      .fontSize(14)
                      .height(34)
                      .layoutWeight(1)
                      .backgroundColor(Design.SUCCESS)
                      .onClick(() => {
                        this.appState.approveApproval(a.approvalId, true)
                      })
                    Button(I18n.t('拒绝', 'Deny'))
                      .fontSize(14)
                      .height(34)
                      .layoutWeight(1)
                      .backgroundColor(Design.DANGER)
                      .onClick(() => {
                        this.appState.approveApproval(a.approvalId, false)
                      })
                  }.width('100%')
                }
                .width('100%')
                .padding(12)
                .backgroundColor(Design.FILL_LIGHT(this.uiDark))
                .borderRadius(10)
                .alignItems(HorizontalAlign.Start)
              }, (a: PendingApproval) => a.approvalId)

              ForEach(this.currentQuestions(), (q: PendingQuestion) => {
                Column({ space: 8 }) {
                  Text(I18n.t('提问', 'Questions'))
                    .fontSize(15)
                    .fontWeight(FontWeight.Bold)
                  ForEach(q.questions, (item: Record<string, Object>, idx: number) => {
                    Column({ space: 6 }) {
                      Text(this.questionText(item, idx))
                        .fontSize(14)
                        .width('100%')
                      ForEach(item['options'] as Array<Record<string, Object>> ?? [], (opt: Record<string, Object>) => {
                        Row() {
                          Text(this.isSelected(idx, String(opt['label'] ?? '')) ? '☑ ' : '☐ ')
                            .fontSize(14)
                            .fontColor(this.accent())
                          Text(String(opt['label'] ?? ''))
                            .fontSize(13)
                            .layoutWeight(1)
                        }
                        .width('100%')
                        .padding({ top: 4, bottom: 4 })
                        .onClick(() => {
                          this.toggleChoice(idx, String(opt['label'] ?? ''))
                        })
                      }, (opt: Record<string, Object>) => String(opt['label'] ?? ''))
                      TextInput({
                        text: this.choiceAt(idx).custom,
                        placeholder: I18n.t('补充说明（可选）', 'Additional note (optional)')
                      })
                        .height(36)
                        .fontSize(13)
                        .onChange((value: string) => {
                          this.setCustom(idx, value)
                        })
                    }
                    .width('100%')
                    .alignItems(HorizontalAlign.Start)
                  }, (item: Record<string, Object>, idx: number) => String(idx) + String(item['id'] ?? ''))

                  Button(I18n.t('提交回答', 'Submit answers'))
                    .fontSize(14)
                    .height(36)
                    .width('100%')
                    .backgroundColor(this.accent())
                    .onClick(() => {
                      this.submitAnswers(q.rpcId)
                    })
                }
                .width('100%')
                .padding(12)
                .backgroundColor(Design.FILL_LIGHT(this.uiDark))
                .borderRadius(10)
                .alignItems(HorizontalAlign.Start)
              }, (q: PendingQuestion) => q.rpcId)

              if (this.pendingNote.length > 0) {
                Text(this.pendingNote)
                  .fontSize(12)
                  .fontColor(Design.DANGER)
                  .width('100%')
              }
            }
            .padding({ left: 16, right: 16, bottom: 16 + Design.safeBottom() })
            .width('100%')
          }
          .layoutWeight(1)
          .scrollBar(BarState.Off)
        }
        .width('100%')
        .height('55%')
        .backgroundColor(Design.SURFACE(this.uiDark))
        .borderRadius({ topLeft: 24, topRight: 24 })
        .align(Alignment.Bottom)
      }

      // 模型选择覆盖层
      if (this.showModels) {
        Column()
          .width('100%')
          .height('100%')
          .backgroundColor(Design.scrim(this.uiDark))
          .onClick(() => {
            this.showModels = false
          })

        Column() {
          Row() {
            Text(I18n.t('模型选择', 'Model selection'))
              .fontSize(18)
              .fontWeight(FontWeight.Bold)
            Blank()
            Text(I18n.t('关闭', 'Close'))
              .fontSize(14)
              .fontColor(this.accent())
              .onClick(() => {
                this.showModels = false
              })
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 12, bottom: 8 })

          Scroll() {
            Column({ space: 14 }) {
              if (this.modelGroups.length === 0) {
                Text(I18n.t('加载中或暂无可选模型', 'Loading, or no models available'))
                  .fontSize(13)
                  .fontColor(Design.TEXT_SUB(this.uiDark))
                  .width('100%')
                  .padding(12)
              } else {
                ForEach(this.modelGroups, (g: ModelGroup) => {
                  Column({ space: 8 }) {
                    Text(g.name)
                      .fontSize(15)
                      .fontWeight(FontWeight.Bold)
                      .width('100%')
                    Flex({ wrap: FlexWrap.Wrap }) {
                      ForEach(g.models, (m: ModelEntry) => {
                        this.modelChip(g.id, m)
                      }, (m: ModelEntry) => g.id + '/' + m.id)
                    }
                    .width('100%')
                  }
                  .width('100%')
                  .alignItems(HorizontalAlign.Start)
                }, (g: ModelGroup) => g.id)

                if (this.currentModelEntry() !== null && this.currentEffortOptions().length > 0) {
                  Column({ space: 8 }) {
                    Text(I18n.t('思考档位', 'Reasoning effort'))
                      .fontSize(15)
                      .fontWeight(FontWeight.Bold)
                      .width('100%')
                    Flex({ wrap: FlexWrap.Wrap }) {
                      ForEach(this.currentEffortOptions(), (e: EffortOption) => {
                        this.effortChip(e)
                      }, (e: EffortOption) => e.id)
                    }
                    .width('100%')
                  }
                  .width('100%')
                  .alignItems(HorizontalAlign.Start)
                }
              }
            }
            .padding({ left: 16, right: 16, bottom: 16 + Design.safeBottom() })
            .width('100%')
            .alignItems(HorizontalAlign.Start)
          }
          .layoutWeight(1)
          .scrollBar(BarState.Off)
        }
        .width('100%')
        .height('60%')
        .backgroundColor(Design.SURFACE(this.uiDark))
        .borderRadius({ topLeft: 24, topRight: 24 })
        .align(Alignment.Bottom)
      }

      // 重命名覆盖层
      if (this.showRename) {
        this.renameOverlay()
      }
    }
    .width('100%')
    .height('100%')
  }

  private questionText(item: Record<string, Object>, idx: number): string {
    const text = String(item['question'] ?? '')
    const header = String(item['header'] ?? '')
    if (header.length > 0) {
      return `${idx + 1}. ${header}：${text}`
    }
    return `${idx + 1}. ${text}`
  }

  private decodeImages(m: ChatMessage): void {
    for (let i = 0; i < m.images.length; i++) {
      this.decodeOne(m.seq, i, m.images[i])
    }
  }

  private async decodeOne(seq: number, index: number, dataUrl: string): Promise<void> {
    try {
      const pixelMap = await ImageDecoder.decode(dataUrl)
      this.decodedImages = [...this.decodedImages, new DecodedImage(seq, index, pixelMap)]
    } catch (e) {
      // 解码失败保持占位
    }
  }

  private pixelFor(seq: number, index: number): image.PixelMap | null {
    for (const d of this.decodedImages) {
      if (d.seq === seq && d.index === index) {
        return d.pixelMap
      }
    }
    return null
  }

  private currentEffortOptions(): EffortOption[] {
    const entry = this.currentModelEntry()
    return entry ? entry.effortOptions() : []
  }

  private currentEffortId(): string {
    const cur = this.currentModel
    return cur ? cur.reasoningEffort : ''
  }

  private isEffortCurrent(effortId: string): boolean {
    const entry = this.currentModelEntry()
    if (!entry) {
      return false
    }
    return entry.isCurrentEffort(effortId, this.currentEffortId())
  }

  @Builder
  modelChip(provider: string, m: ModelEntry) {
    Text(m.name)
      .fontSize(13)
      .padding({ left: 12, right: 12, top: 7, bottom: 7 })
      .backgroundColor(this.isCurrentModel(provider, m.id) ? this.accent() : Design.FILL_LIGHT(this.uiDark))
      .fontColor(this.isCurrentModel(provider, m.id) ? Color.White : Design.TEXT_MAIN(this.uiDark))
      .borderRadius(Design.RADIUS_PILL)
      .margin({ right: 6, bottom: 6 })
      .onClick(() => {
        this.selectModel(provider, m.id)
      })
  }

  @Builder
  effortChip(e: EffortOption) {
    Text(e.name)
      .fontSize(13)
      .padding({ left: 12, right: 12, top: 7, bottom: 7 })
      .backgroundColor(this.isEffortCurrent(e.id) ? this.accent() : Design.FILL_LIGHT(this.uiDark))
      .fontColor(this.isEffortCurrent(e.id) ? Color.White : Design.TEXT_MAIN(this.uiDark))
      .borderRadius(Design.RADIUS_PILL)
      .margin({ right: 6, bottom: 6 })
      .onClick(() => {
        this.selectEffort(e.id)
      })
  }

  @Builder
  messageRow(item: ChatMessage) {
    if (item.role === 'user') {
      this.userBubble(item)
    } else if (item.role === 'compaction') {
      this.compactionBar(item)
    } else if (item.role === 'assistant') {
      this.assistantBubble(item)
    } else if (item.role === 'tool') {
      // 工具调用/结果卡片：白底小气泡左对齐，等宽字体
      Column({ space: 4 }) {
        Text(item.text)
          .fontSize(12)
          .fontFamily('monospace')
          .fontColor(Design.TEXT_SUB(this.uiDark))
          .copyOption(CopyOptions.LocalDevice)
      }
      .alignItems(HorizontalAlign.Start)
      .padding({ left: 10, right: 10, top: 7, bottom: 7 })
      .backgroundColor(Design.SURFACE(this.uiDark))
      .borderRadius(Design.RADIUS_CONTROL)
      .constraintSize({ maxWidth: '86%' })
    } else if (item.type === 'agent/status') {
      // 纯状态行（任务开始/结束）：居中灰字，无气泡
      Text(item.text)
        .fontSize(12)
        .fontColor(Design.TEXT_HINT(this.uiDark))
        .width('100%')
        .textAlign(TextAlign.Center)
        .padding({ top: 6, bottom: 6 })
    } else {
      // 其余 role 缺失消息：白底小气泡左对齐，不裸排居中
      this.assistantBubble(item)
    }
  }

  @Builder
  streamRow() {
    Column() {
      Text(this.streamText.length > 0 ? I18n.t('思考中…', 'Thinking…') : I18n.t('正在思考…', 'Thinking…'))
        .fontSize(12)
        .fontColor(Design.TEXT_HINT(this.uiDark))
      if (this.streamText.length > 0) {
        Text(this.streamText)
          .fontSize(14)
          .fontColor(Design.TEXT_MAIN(this.uiDark))
          .copyOption(CopyOptions.LocalDevice)
      }
    }
    .alignItems(HorizontalAlign.Start)
    .padding(12)
    .backgroundColor(Design.SURFACE(this.uiDark))
    .borderRadius({
      topLeft: Design.RADIUS_CARD,
      topRight: Design.RADIUS_CARD,
      bottomLeft: Design.RADIUS_SMALL,
      bottomRight: Design.RADIUS_CARD
    })
    .shadow(Design.cardShadow(this.uiDark))
    .constraintSize({ maxWidth: '86%' })
  }

  @Builder
  userBubble(item: ChatMessage) {
    Row() {
      // 气泡本体（自适应内容宽，受 maxWidth 约束）；占位列推到右侧
      Column() {
        if (item.images.length > 0) {
          ForEach(item.images, (img: string, idx: number) => {
            if (this.pixelFor(item.seq, idx)) {
              Image(this.pixelFor(item.seq, idx) as image.PixelMap)
                .width(200)
                .height(200)
                .objectFit(ImageFit.Contain)
                .borderRadius(8)
                .margin({ bottom: 4 })
            } else {
              Text(I18n.t('[图片]', '[image]'))
                .fontSize(12)
                .fontColor('#B8D4FF')
                .margin({ bottom: 4 })
            }
          }, (img: string, idx: number) => item.seq.toString() + '-' + idx.toString())
        }
        if (item.text.length > 0) {
          MarkdownView({
            text: item.text,
            baseColor: '#FFFFFF',
            codeBg: '#33FFFFFF',
            codeColor: '#FFFFFF',
            quoteBar: '#66FFFFFF',
            accent: '#FFFFFF',
            followTheme: false
          })
        }
      }
      .alignItems(HorizontalAlign.End)
      .padding(12)
      .backgroundColor(this.accent())
      .borderRadius({
        topLeft: Design.RADIUS_CARD,
        topRight: Design.RADIUS_CARD,
        bottomLeft: Design.RADIUS_CARD,
        bottomRight: Design.RADIUS_SMALL
      })
      .shadow(Design.cardShadow(this.uiDark))
      .constraintSize({ maxWidth: '84%' })

      Blank().layoutWeight(1)
    }
    .width('100%')
    .justifyContent(FlexAlign.End)
  }

  @Builder
  assistantBubble(item: ChatMessage) {
    Column({ space: 6 }) {
      if (item.images.length > 0) {
        ForEach(item.images, (img: string, idx: number) => {
          if (this.pixelFor(item.seq, idx)) {
            Image(this.pixelFor(item.seq, idx) as image.PixelMap)
              .width(200)
              .height(200)
              .objectFit(ImageFit.Contain)
              .borderRadius(8)
              .margin({ bottom: 4 })
          } else {
            Text(I18n.t('[图片]', '[image]'))
              .fontSize(12)
              .fontColor(Design.TEXT_HINT(this.uiDark))
              .margin({ bottom: 4 })
          }
        }, (img: string, idx: number) => item.seq.toString() + '-' + idx.toString())
      }
      // 思考过程：默认折叠 3 行，点击展开
      if (item.reasoning.length > 0) {
        Column({ space: 4 }) {
          Row() {
            Text(I18n.t('思考过程', 'Reasoning'))
              .fontSize(11)
              .fontColor(Design.TEXT_HINT(this.uiDark))
            Blank().layoutWeight(1)
            Text(this.isReasoningExpanded(item.seq) ? I18n.t('收起', 'Collapse') : I18n.t('展开', 'Expand'))
              .fontSize(11)
              .fontColor(this.accent())
          }

          Text(item.reasoning)
            .fontSize(13)
            .fontColor(Design.TEXT_SUB(this.uiDark))
            .maxLines(this.isReasoningExpanded(item.seq) ? 9999 : 3)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .padding(8)
        .backgroundColor(Design.SURFACE_SUB(this.uiDark))
        .borderRadius(8)
        .onClick(() => {
          this.toggleReasoning(item.seq)
        })
      }
      // 工具调用摘要
      if (item.tools.length > 0) {
        Row({ space: 6 }) {
          Image($r('app.media.ic_code'))
            .width(13)
            .height(13)
            .fillColor(Design.TEXT_HINT(this.uiDark))
          Text(item.toolsLabel())
            .fontSize(11)
            .fontColor(Design.TEXT_HINT(this.uiDark))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }
      if (item.text.length > 0) {
        MarkdownView({ text: item.text, dark: this.uiDark })
      }
    }
    .alignItems(HorizontalAlign.Start)
    .padding(12)
    .backgroundColor(Design.SURFACE(this.uiDark))
    .borderRadius({
      topLeft: Design.RADIUS_SMALL,
      topRight: Design.RADIUS_CARD,
      bottomLeft: Design.RADIUS_CARD,
      bottomRight: Design.RADIUS_CARD
    })
    .shadow(Design.cardShadow(this.uiDark))
    .constraintSize({ maxWidth: '86%' })
  }

  /**
   * 压缩摘要条：默认折叠为一行，点击展开/收起完整摘要。
   * /compact 注入的 checkpoint 对用户是背景信息，折叠避免干扰当前工作。
   */
  @Builder
  compactionBar(item: ChatMessage) {
    Column({ space: 6 }) {
      Row({ space: 8 }) {
        Image($r('app.media.ic_folder'))
          .width(16)
          .height(16)
          .fillColor(this.accent())
        Text(I18n.t('已压缩的历史对话', 'Compacted history'))
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor(Design.TEXT_MAIN(this.uiDark))
          .layoutWeight(1)
        Text(this.expandedCompaction === item.seq ? I18n.t('收起', 'Collapse') : I18n.t('展开', 'Expand'))
          .fontSize(12)
          .fontColor(this.accent())
      }
      .width('100%')
      .onClick(() => {
        if (this.expandedCompaction === item.seq) {
          this.expandedCompaction = -1
        } else {
          this.expandedCompaction = item.seq
        }
      })

      if (this.expandedCompaction === item.seq) {
        MarkdownView({ text: item.compaction, dark: this.uiDark })
          .width('100%')
      }
    }
    .alignItems(HorizontalAlign.Start)
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .backgroundColor(Design.FILL_LIGHT(this.uiDark))
    .borderRadius(Design.RADIUS_CONTROL)
    .width('100%')
  }

  /** 重命名弹层：TextInput + 确认/取消 */
  @Builder
  renameOverlay() {
    Stack() {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(Design.scrim(this.uiDark))
        .onClick(() => {
          this.showRename = false
        })
      Column({ space: 14 }) {
        Text(I18n.t('重命名会话', 'Rename session'))
          .fontSize(17)
          .fontWeight(FontWeight.Bold)
          .fontColor(Design.TEXT_MAIN(this.uiDark))
        TextInput({ text: $$this.renameText, placeholder: I18n.t('输入新标题', 'New title') })
          .height(44)
          .fontSize(14)
          .maxLength(80)
          .borderRadius(Design.RADIUS_CONTROL)
        Row({ space: 10 }) {
          Button(I18n.t('取消', 'Cancel'))
            .fontSize(14)
            .height(40)
            .layoutWeight(1)
            .backgroundColor(Design.FILL_LIGHT(this.uiDark))
            .fontColor(Design.TEXT_MAIN(this.uiDark))
            .borderRadius(Design.RADIUS_CONTROL)
            .onClick(() => {
              this.showRename = false
            })
          Button(I18n.t('保存', 'Save'))
            .fontSize(14)
            .height(40)
            .layoutWeight(1)
            .backgroundColor(this.accent())
            .borderRadius(Design.RADIUS_CONTROL)
            .onClick(() => {
              this.submitRename()
            })
        }
        .width('100%')
      }
      .padding(20)
      .borderRadius(Design.RADIUS_CARD)
      .backgroundColor(Design.SURFACE(this.uiDark))
      .margin({ left: 32, right: 32 })
    }
    .width('100%')
    .height('100%')
    .alignContent(Alignment.Center)
  }

  private isReasoningExpanded(seq: number): boolean {
    return this.expandedReasoning.includes(seq)
  }

  private toggleReasoning(seq: number): void {
    if (this.expandedReasoning.includes(seq)) {
      this.expandedReasoning = this.expandedReasoning.filter((n: number) => n !== seq)
    } else {
      this.expandedReasoning = [...this.expandedReasoning, seq]
    }
  }

  /** 停止当前任务：先确认，再发 session.cancel */
  private confirmCancel(): void {
    AlertDialog.show({
      title: I18n.t('停止当前任务', 'Stop current turn'),
      message: I18n.t('将中断正在运行的这一轮对话，已产生的输出会保留。', 'This interrupts the running turn; generated output is kept.'),
      autoCancel: true,
      primaryButton: {
        value: I18n.t('取消', 'Cancel'),
        action: () => {
        }
      },
      secondaryButton: {
        value: I18n.t('停止', 'Stop'),
        fontColor: Design.DANGER,
        action: () => {
          this.cancelSession()
        }
      }
    })
  }

  private async cancelSession(): Promise<void> {
    const s = this.appState.server
    if (!s || this.sessionId.length === 0) {
      return
    }
    try {
      const payload: SessionCancelPayload = { sessionId: this.sessionId }
      await GatewayApi.rpc(s.normalizedUrl(), s.token, 'session.cancel', payload)
      this.pendingNote = I18n.t('已请求停止', 'Stop requested')
    } catch (e) {
      this.pendingNote = I18n.t('停止失败：', 'Stop failed: ') + (e as Error).message
    }
  }

  private hasImages(item: ChatMessage): boolean {
    return item.images.length > 0
  }
}