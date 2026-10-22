/* Guided practice for the mobile WebUI and Android WebView. No network ownership. */
;(function(root) {
  'use strict'
  const KEY = 'dshRemoteOnboardingV1'
  const $ = id => document.getElementById(id)
  const text = (zh, en) => root.I18N?.lang === 'en' ? en : zh
  const steps = [
    { id: 'connect', title: ['先连接你的电脑', 'Connect your computer'],
      body: ['手机是遥控器，DSH 和模型运行在电脑上。电脑需要开机，DSH 与 Remote 网关需要保持运行。', 'Your phone controls DSH and its model on your computer. Keep the computer, DSH and Remote gateway running.'],
      tips: [
        ['在电脑的 DSH 中安装 Remote 插件，打开插件里的连接向导。手机选择“扫码连接”，扫描连接码；下载 APK 的二维码用于安装，不能拿来配对。', 'Install Remote in DSH on the computer and open its connection wizard. Scan the connection QR on the phone; the APK download QR installs the app and does not pair it.'],
        ['同一 Wi-Fi 下可用局域网地址。离开家后需要可达的中转或组网地址；手机里的 localhost 指向手机自己。', 'Use the LAN address on the same Wi-Fi. Away from home, use a reachable relay or private-network address. On a phone, localhost means the phone itself.'],
        ['连接码含访问凭证，请不要公开截图。“主机与连接”可以重新扫码或修改地址。', 'Connection QR codes contain credentials. Keep them private. Hosts and connections lets you scan again or edit addresses.']
      ], action: ['打开主机与连接', 'Open hosts and connections'], target: '#workflow-connection' },
    { id: 'session', title: ['选择工作区，打开一段对话', 'Choose a workspace and open a conversation'],
      body: ['工作区是电脑上的项目目录；会话是在这个目录里进行的一段对话。可以打开已有会话，也可以新建。', 'A workspace is a project folder on the computer. A conversation works in that folder. Open an existing conversation or create one.'],
      tips: [
        ['新建时先确认工作区名称和完整路径，再选主机提供的对话类型。不确定时保留默认类型。', 'When creating a conversation, check the workspace name and full path, then choose an agent type supplied by the host. Keep the default if unsure.'],
        ['没有工作区时，按新建面板里的“浏览主机目录”选择目录，再使用当前目录或新建工作区。这里选择的是电脑目录，不是手机目录。', 'With no workspace, use Browse host folders in the creation panel. Choose a folder, then use it or create a workspace. These folders are on the computer, not the phone.'],
        ['切换主机会切换对应的工作区和历史；请先确认页面显示的主机。', 'Changing hosts changes the workspaces and history you see. Check the selected host first.']
      ], action: ['选择或新建会话', 'Choose or create a conversation'], target: '#btn-new-session' },
    { id: 'message', title: ['亲手发出第一条消息', 'Send your first message'],
      body: ['在下方输入需求，点击“发送”。消息会发给当前电脑的 DSH，使用你已配置的模型和额度。', 'Type a request below and tap Send. It goes to DSH on the selected computer and uses your configured model and quota.'],
      tips: [
        ['可以自己写一句问候，也可以把示例放入空白输入框。示例只填草稿，需要你再点击发送。', 'Write a greeting or place the example in an empty composer. The example only fills a draft; you still tap Send.'],
        ['输入区的“模型”按钮可选择模型与思考深度；“指令”提供常用命令和权限预设。不确定时保留主机默认设置。', 'Model near the composer selects the model and reasoning depth. Commands includes common commands and permission presets. Keep the host defaults if unsure.'],
        ['如果暂时不想调用模型，选择“先跳过这步”。引导不会替你发送。', 'Choose Skip this step if you do not want to call the model yet. The guide never sends for you.'],
        ['运行中普通点击是排队，等待当前轮完成；“插队发送”会调整当前任务方向，先读清按钮再操作。', 'While a turn is running, a normal click queues your message. Steer changes the direction of the current task. Read the button before using it.']
      ], action: ['定位输入框', 'Find the composer'], target: '#composer-input' },
    { id: 'results', title: ['看懂回复、审批和发送结果', 'Understand replies, approvals and send results'],
      body: ['“已发送”表示主机已接受，不代表模型已经回复。运行状态、对话记录和待处理事项会告诉你下一步。', 'Sent means the host accepted the request, not that the model has replied. Check the running status, history and items needing attention.'],
      tips: [
        ['出现审批或问题时，先看具体内容，再允许、拒绝或回答。“停止本轮”用于请求停止当前任务。', 'When an approval or question appears, read it before allowing, denying or answering. Stop turn requests cancellation of the current task.'],
        ['网络断开或“结果未确认”时，先核对历史和操作回执；重复发送可能执行两次。回执里的“查询结果”用于核对原请求。', 'After a disconnect or an unconfirmed result, check history and receipts before sending again. Repeating a request may run it twice. Check result looks up the original request.'],
        ['模型或权限报错会保留在对话里。重试前先看错误原因，必要时打开 AI 排查或写反馈。', 'Model and permission errors remain in the conversation. Read the error before retrying; use AI diagnosis or feedback if needed.']
      ], action: ['查看审批与操作回执', 'Open approvals and receipts'], target: '#history' },
    { id: 'files', title: ['分清图片附件和文件传输', 'Use images and file transfer'],
      body: ['对话里的图片按钮用来附上截图或照片；底部“文件”页用来浏览、上传和下载电脑文件。', 'The image button in a conversation attaches a screenshot or photo. Files in the bottom navigation browses, uploads and downloads computer files.'],
      tips: [
        ['选择图片后先看附件预览，再随消息发送。能否理解图片还取决于主机模型或图片理解插件。', 'Review the image attachment before sending it with your message. Image understanding depends on the host model or vision plugin.'],
        ['文件上传到当前电脑、当前目录；上传前确认路径，上传后核对列表与进度。传到电脑不等于已作为对话附件发送。', 'Files upload to the selected computer and folder. Check the path first, then the file list and progress. Uploading does not automatically attach a file to a conversation.'],
        ['本步只带你查看入口，不会自动选择或上传任何文件。', 'This step only opens the controls. It does not select or upload files.']
      ], action: ['打开文件页', 'Open Files'], target: '#fs-upload-btn' },
    { id: 'branch', title: ['从一条回复继续尝试另一条思路', 'Try another direction with a branch'],
      body: ['一轮回复结束后，结果下方可出现“从此处分支”。分支会创建另一段会话，从选定位置继续。', 'After a completed turn, Branch from here may appear below the result. It creates another conversation continuing from that point.'],
      tips: [
        ['适合比较另一种方案，同时保留原会话。分支不会撤销已经修改的文件。', 'Use it to compare another approach while keeping the original conversation. A branch does not undo file changes.'],
        ['看不到按钮时，可能还没有完整回复，或当前主机、会话不支持分支；可以跳过，不需要为了学习额外运行任务。', 'If the button is missing, the turn may be incomplete or branching unsupported for this host or conversation. You can skip without running an extra task.'],
        ['引导只定位分支按钮，不会替你创建分支。', 'The guide only locates the branch control. It does not create a branch.']
      ], action: ['回到会话查看分支入口', 'Find branching in the conversation'], target: '[data-turn-action="fork"]' },
    { id: 'doctor', title: ['遇到异常，先让 AI 帮你排查', 'Use AI diagnosis when something goes wrong'],
      body: ['首页的“AI 排查问题”会打开说明面板。确认排查范围后，再由你点击“开始”。', 'AI diagnosis on the home page opens an explanation panel. Review the scope, then choose Start yourself.'],
      tips: [
        ['排查使用你的 DSH 和模型，会消耗模型额度。正常开始后会进入诊断会话，在对话里查看结果。', 'Diagnosis uses your DSH and model quota. A successful start opens a diagnosis conversation where you can read the result.'],
        ['诊断按只读范围排查；需要改动时先确认建议。如果面板关闭却没有会话或回复，这也是可以反馈的问题。', 'Diagnosis investigates within its read-only scope. Review any suggested changes. A panel closing without a conversation or reply is itself worth reporting.'],
        ['这一步只打开说明，不会自动开始诊断。你也可以直接写反馈。', 'This step only opens the explanation. It does not start diagnosis. You can also go directly to feedback.']
      ], action: ['查看 AI 排查说明', 'View AI diagnosis'], target: '#home-doctor' },
    { id: 'feedback', title: ['写一条能复现问题的反馈', 'Write feedback that can be reproduced'],
      body: ['不需要 GitHub 账号。可以在 App 内填写反馈；以后从“更多 → 关于与维护 → 提交反馈”重新进入。', 'No GitHub account is needed for in-app feedback. Find it again under More → About and maintenance → Send feedback.'],
      tips: [
        ['按顺序写：在哪个页面 → 点了什么 → 预期发生什么 → 实际发生什么。补充是否每次出现，以及 App/浏览器和电脑系统。', 'Describe the page → what you clicked → what you expected → what happened. Include how often it happens, the app/browser and the computer OS.'],
        ['诊断日志和崩溃摘要都由你选择是否附带，可以先查看摘要。不要在描述或截图中公开令牌、二维码或密钥。', 'You choose whether to include diagnostic or crash summaries and can preview them. Keep tokens, QR credentials and keys out of descriptions and screenshots.'],
        ['只有服务器确认后才会显示“反馈发送成功”。现在只是学习入口，不必为了完成引导提交测试反馈。', 'Feedback sent appears only after server confirmation. You do not need to submit test feedback to finish this guide.']
      ], action: ['打开反馈表单', 'Open feedback form'], target: '#fb-msg' }
  ]
  let config, progress, active = false, folded = false, card, entry, restart, signature = '', highlighted, sessionStamp = '', sent = false
  const read = () => {
    try {
      const value = JSON.parse(root.localStorage.getItem(KEY))
      if (value?.schema === 1 && Number.isInteger(value.step) && value.step >= 0 && value.step < steps.length
        && ['new', 'paused', 'complete', 'skipped'].includes(value.status)) return { schema: 1, step: value.step, status: value.status }
    } catch {}
    return { schema: 1, step: 0, status: 'new' }
  }
  function save() {
    // A reload after an accepted message must not invite a second practice send.
    const stored = { ...progress, step: progress.step === 2 && sent ? 3 : progress.step }
    try { root.localStorage.setItem(KEY, JSON.stringify(stored)) } catch {}
  }
  function el(tag, cls, content) {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (content) node.textContent = content
    return node
  }
  function button(content, action, kind = '') {
    const node = el('button', 'onboarding-button ' + kind, content); node.type = 'button'
    node.addEventListener('click', action); return node
  }
  function clearHighlight() { highlighted?.classList.remove('onboarding-target'); highlighted = null }
  function snapshot() { return config.snapshot() || {} }
  function ready(live) {
    if (progress.step === 0) return !!live.connected
    if (progress.step === 1) return !!live.connected && !!live.session && !!live.sessionReady
    if (progress.step === 2) return !!live.connected && !!live.session && sent && sessionStamp === JSON.stringify([live.connection, live.session])
    return true
  }
  function start(reset = false) {
    if (reset || progress.status === 'complete' || progress.status === 'skipped') progress = { schema: 1, step: 0, status: 'paused' }
    active = true; folded = false; progress.status = 'paused'; save(); signature = ''
    update(); card.scrollIntoView?.({ block: 'nearest', behavior: 'auto' }); card.focus?.({ preventScroll: true })
  }
  function pause() {
    if (progress.step === 2 && sent) progress.step = 3
    active = false; progress.status = 'paused'; save(); clearHighlight(); signature = ''; update()
  }
  function skipAll() {
    if (!active) return
    active = false; progress.status = 'skipped'
    clearHighlight(); config.closePractice?.(); save(); signature = ''; update()
  }
  function advance(skip = false) {
    if (!active || (!skip && !ready(snapshot()))) return
    clearHighlight()
    config.closePractice?.()
    folded = false
    if (progress.step === steps.length - 1) {
      active = false; progress.status = 'complete'
    } else progress.step++
    save(); signature = ''; update()
    if (active) card.scrollIntoView?.({ block: 'nearest', behavior: 'auto' })
  }
  function placement() {
    // Unrelated notices, approvals and native dialogs keep precedence.
    const modal = document.querySelector('.modal:not(.hidden), dialog[open], .doctor-overlay:not(.hidden)')
    if (modal) {
      if ((modal.id === 'modal-new-session' && progress.step === 1) || (modal.id === 'modal-feedback' && progress.step === 7)) {
        return modal.querySelector('.modal-body') || modal.querySelector('.modal-card')
      }
      return null
    }
    return document.querySelector('#main > .view:not(.hidden)')
  }
  function waiting(live) {
    if (progress.step < 3 && !live.connected) return text('尚未确认电脑连接。先打开主机与连接，确认地址和电脑上的 DSH 正在运行。', 'Computer connection is not confirmed. Check the host address and that DSH is running.')
    if (progress.step === 1) return text('等你打开会话并加载历史后，这一步才会完成。', 'This step completes after you open a conversation and its history loads.')
    if (progress.step === 2 && !live.session) return text('当前没有打开会话，先打开或新建一段会话。', 'Open or create a conversation first.')
    if (progress.step === 2) return text('等待主机确认接受你发出的普通消息；点击发送或“结果未确认”都不算完成。', 'Waiting for the host to accept a normal message. A click or unconfirmed result does not count.')
    return text('先看说明，需要时再打开入口练习；不必真的执行操作。', 'Read the explanation and open the controls if useful. You do not have to perform the action.')
  }
  function render(live) {
    const step = steps[progress.step], complete = ready(live)
    card.replaceChildren()
    const header = el('div', 'onboarding-head'), caption = el('span', 'onboarding-eyebrow', text('新手引导', 'Getting started') + ' · ' + (progress.step + 1) + '/' + steps.length)
    const headerActions = el('div', 'onboarding-head-actions')
    const fold = button(folded ? text('展开', 'Expand') : text('收起', 'Collapse'), () => {
      folded = !folded; card.classList.toggle('is-folded', folded)
      fold.textContent = folded ? text('展开', 'Expand') : text('收起', 'Collapse')
      fold.setAttribute('aria-expanded', String(!folded))
    }, 'onboarding-subtle')
    fold.setAttribute('aria-expanded', String(!folded))
    headerActions.append(fold, button(text('稍后继续', 'Pause'), pause, 'onboarding-subtle'))
    header.append(caption, headerActions)
    const title = el('h2', '', text(...step.title)); title.id = 'onboarding-title'
    const status = el('p', 'onboarding-status', progress.step < 3 && complete
      ? text('✓ 已确认这一步，可以继续。', '✓ This step is confirmed. You can continue.') : waiting(live))
    status.setAttribute('role', 'status')
    const details = el('details', 'onboarding-details'), summary = el('summary', '', text('操作说明与遇到问题怎么办', 'How to do it and recover from problems'))
    const list = el('ol')
    for (const tip of step.tips) list.append(el('li', '', text(...tip)))
    details.append(summary, list)
    const actions = el('div', 'onboarding-actions'), locate = button(text(...step.action), () => void practice(), 'onboarding-primary')
    locate.dataset.onboardingAction = 'practice'
    actions.append(locate)
    if (progress.step === 2) actions.append(button(text('把示例放入空白输入框', 'Put example in empty composer'), () => {
      if (!snapshot().session || !snapshot().connected) return
      const placed = config.example?.(text('请用一句话介绍你能帮我做什么。', 'In one sentence, what can you help me with?'))
      status.textContent = placed ? text('已填入草稿。需要你自己点击发送。', 'Draft filled. Tap Send yourself.') : text('已保留你的草稿，请继续输入或自己发送。', 'Your draft is preserved. Continue typing or send it yourself.')
    }))
    const next = button(progress.step === steps.length - 1 ? text('完成引导', 'Finish guide') : text('下一步', 'Next'), () => advance())
    next.disabled = !complete; next.dataset.onboardingAction = 'next'
    const navigation = el('div', 'onboarding-navigation')
    if (progress.step > 0) navigation.append(button(text('上一步', 'Back'), () => {
      config.closePractice?.(); folded = false; progress.step--; save(); signature = ''; update()
    }, 'onboarding-subtle'))
    navigation.append(button(text('先跳过这步', 'Skip this step'), () => advance(true), 'onboarding-subtle'), next)
    const dismiss = button(text('跳过整个引导，以后在“更多”中查看', 'Skip the guide; find it later in More'), skipAll, 'onboarding-subtle')
    card.append(header, title, el('p', 'onboarding-body', text(...step.body)), status, details, actions, navigation, dismiss)
    card.classList.toggle('is-folded', folded)
    card.scrollTop = 0
  }
  async function practice() {
    if (!active) return
    const step = steps[progress.step], at = progress.step
    try {
      await config.actions[step.id]?.()
      if (!active || progress.step !== at) return
      update()
      clearHighlight()
      const target = document.querySelector(step.target)
      if (target && target.getClientRects().length && !card.hidden) {
        highlighted = target; target.classList.add('onboarding-target')
        target.scrollIntoView?.({ block: 'nearest', behavior: 'auto' })
        if (step.id === 'message') target.focus?.({ preventScroll: true })
      } else if (step.id === 'branch' && !card.hidden) {
        card.querySelector('.onboarding-status').textContent = text('当前没有可用的分支按钮。完整回复结束且主机支持后才会出现，可先继续。', 'No branch control is available yet. It needs a completed turn and host support. You can continue.')
      }
    } catch {
      if (active && progress.step === at) card.querySelector('.onboarding-status').textContent = text('入口暂时无法打开。可以稍后再试，或先跳过这一步。', 'Unable to open this right now. Try later or skip this step.')
    }
  }
  function update() {
    if (!config) return
    const live = snapshot(), stamp = JSON.stringify([live.connection, live.session])
    if (stamp !== sessionStamp) { sessionStamp = stamp; sent = false; clearHighlight() }
    if (!active) {
      card.hidden = true
      const done = progress.status === 'complete' || progress.status === 'skipped'
      const title = progress.status === 'paused'
        ? text('继续新手引导', 'Continue the guide') + ' · ' + (progress.step + 1) + '/' + steps.length : text('第一次用？一步一步带你上手', 'First time? Let us guide you')
      entry.querySelector('strong').textContent = title
      entry.querySelector('span').textContent = text('每次只做一件事，随时暂停或跳过。', 'One task at a time. Pause or skip whenever you like.')
      restart.querySelector('.setting-name').textContent = text('新手引导', 'Getting started')
      restart.querySelector('.setting-desc').textContent = done
        ? text('重新查看连接、对话与常见操作', 'Revisit connection, chat and common actions')
        : text('按步骤熟悉连接、对话与常见操作', 'Learn connection, chat and common actions step by step')
      entry.hidden = done
      return
    }
    entry.hidden = true
    const destination = placement()
    card.hidden = !destination
    if (!destination) { clearHighlight(); return }
    if (card.parentElement !== destination) destination.prepend(card)
    const nextSignature = JSON.stringify([progress.step, root.I18N?.lang, !!live.connected, !!live.session, !!live.sessionReady, sent])
    if (nextSignature !== signature) { signature = nextSignature; render(live) }
  }
  function record(type, context) {
    const live = snapshot()
    if (!active || progress.step !== 2 || type !== 'message-accepted' || !live.connected || !context?.session
      || context.session !== live.session || context.connection !== live.connection) return
    const stamp = JSON.stringify([live.connection, live.session])
    if (stamp !== sessionStamp) { sessionStamp = stamp; sent = false }
    sent = true; save(); update()
  }
  function mount(options) {
    if (config || !$('view-home')) return
    config = options; progress = read()
    card = el('section', 'onboarding-coach'); card.id = 'onboarding-coach'; card.tabIndex = -1
    card.setAttribute('aria-labelledby', 'onboarding-title'); card.hidden = true
    entry = button('', () => start(), 'onboarding-entry'); entry.id = 'onboarding-entry'
    entry.append(el('strong'), el('span')); $('view-home').prepend(entry)
    restart = button('', () => start(true), 'workflow-setting-link onboarding-restart'); restart.id = 'onboarding-restart'
    const mark = el('span', 'workflow-setting-icon onboarding-restart-icon'); mark.setAttribute('aria-hidden', 'true')
    const copy = el('span', 'onboarding-restart-copy'); copy.append(el('span', 'setting-name'), el('span', 'setting-desc'))
    restart.append(mark, copy)
    const settings = $('workflow-more-preferences') || $('settings-home'); settings?.append(restart)
    document.body.append(card)
    document.addEventListener('click', () => queueMicrotask(update))
    update()
  }
  root.DshOnboarding = { mount, update, record, start, pause }
})(window)
