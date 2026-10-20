/* DSH Remote doctor entry: quota notice, independent read-only session, and
 * an issue-ready fallback that still works when the host is unreachable.
 * Zero dependencies; all user- or log-derived text is rendered via textContent. */
;(function (root) {
  'use strict'

  const GITHUB_NEW_ISSUE = 'https://github.com/Blank-not-black/dsh-Remote/issues/new'
  const MAX_SYMPTOM = 2000
  const MAX_DIAGNOSTICS = 12000
  const MAX_PROMPT_DIAGNOSTICS = 6000
  const MAX_ISSUE_BODY = 5500
  const STRINGS = {
    zh: {
      title: 'AI 排查插件问题',
      intro: '把问题交给你的 DSH，按证据做一次只读诊断，并整理成可反馈的话术。',
      costTitle: '将使用你自己的 DSH 和模型',
      cost: '开始后会在你的 DSH 中新建独立诊断会话，并使用该会话当前配置的模型（通常是 DSH 默认模型）。会消耗对应模型的额度或产生费用；诊断所需的脱敏信息会发送给该模型服务。你可以随时停止。',
      privacy: '不会自动提交公开反馈。打开 Issue 或复制反馈前，请检查并删除不应公开的信息。',
      symptom: '问题现象',
      symptomPlaceholder: '例如：升级到 0.8.0-rc.6 后，手机端历史记录偶尔停在“加载历史…”，重进会话才恢复。',
      include: '在诊断与反馈草稿中包含本机脱敏操作日志（推荐）',
      includeHint: '只包含操作阶段、耗时、错误位置和连接状态，不含令牌、Cookie、对话正文或完整路径。',
      environment: '当前环境',
      details: '查看将发送给模型的脱敏诊断摘要',
      copyDiagnostics: '复制诊断',
      exportDiagnostics: '导出诊断',
      copyPrompt: '复制排查提示词',
      copyDraft: '复制反馈模板',
      openIssue: '打开 GitHub Issue',
      start: '开始只读诊断',
      starting: '正在创建诊断会话…',
      close: '关闭',
      cancel: '取消',
      noSymptom: '请先描述问题现象，再开始诊断。',
      disconnected: '当前未连接 DSH。仍可复制排查提示词、导出诊断，或打开 Issue 手动反馈。',
      ready: '开始前请确认上面的额度与隐私提示。',
      promptCopied: '排查提示词已复制，可直接粘贴到 DSH 会话。',
      draftCopied: '反馈模板已复制，请补充复现步骤和诊断结论后提交。',
      diagnosticsCopied: '本机脱敏诊断已复制。',
      exportStarted: '已请求导出诊断；若系统未弹出保存框，请改用“复制诊断”。',
      noDiagnostics: '当前没有可用的本机诊断记录。可在问题复现后再试。',
      issueOpened: '已在浏览器打开预填 Issue 页面，请检查内容后手动提交。',
      copyFailed: '复制失败，请手动选择文本复制。',
      createFailed: '未能创建诊断会话。',
      promptRejected: '主机没有接受诊断请求。',
      startFailed: '诊断未能开始：{msg}',
      createdPromptCopied: '诊断会话已创建，但请求未发送；排查提示词已复制，请粘贴后发送。',
      createdPromptManual: '诊断会话已创建，但请求未发送；请在新会话中粘贴排查提示词。',
      started: '诊断会话已开始。它会先收集只读证据，再给出原因和反馈草稿。',
    },
    en: {
      title: 'AI plugin diagnosis',
      intro: 'Let your own DSH collect read-only evidence, explain the likely cause, and prepare feedback.',
      costTitle: 'Uses your own DSH and model',
      cost: 'Starting creates a separate diagnostic session in your DSH and uses the model configured for that session (usually your DSH default). It consumes that model’s quota or incurs charges, and the sanitized diagnostic context is sent to that model service. You can stop at any time.',
      privacy: 'Nothing is submitted publicly automatically. Review and remove sensitive information before opening an issue or sharing a draft.',
      symptom: 'What went wrong?',
      symptomPlaceholder: 'Example: after upgrading to 0.8.0-rc.6, mobile history occasionally stays on “Loading history…” until I reopen the session.',
      include: 'Include this device’s sanitized operation log in the diagnosis and draft (recommended)',
      includeHint: 'Only stages, durations, error locations and connection state. No tokens, cookies, conversation text or full paths.',
      environment: 'Current environment',
      details: 'Preview the sanitized diagnostic context sent to the model',
      copyDiagnostics: 'Copy diagnostics',
      exportDiagnostics: 'Export diagnostics',
      copyPrompt: 'Copy diagnostic prompt',
      copyDraft: 'Copy feedback draft',
      openIssue: 'Open GitHub Issue',
      start: 'Start read-only diagnosis',
      starting: 'Creating diagnostic session…',
      close: 'Close',
      cancel: 'Cancel',
      noSymptom: 'Describe the symptom before starting the diagnosis.',
      disconnected: 'DSH is not connected. You can still copy the prompt, export diagnostics, or open an issue and report manually.',
      ready: 'Review the quota and privacy notice above before starting.',
      promptCopied: 'Diagnostic prompt copied. Paste it into a DSH session.',
      draftCopied: 'Feedback draft copied. Add reproduction steps and the diagnosis before submitting.',
      diagnosticsCopied: 'Sanitized diagnostics copied.',
      exportStarted: 'Diagnostic export requested. If no save dialog appears, use “Copy diagnostics”.',
      noDiagnostics: 'No local diagnostic record is available yet. Try again after reproducing the problem.',
      issueOpened: 'The prefilled issue page was opened in your browser. Review it and submit manually.',
      copyFailed: 'Copy failed. Select the text and copy it manually.',
      createFailed: 'Could not create the diagnostic session.',
      promptRejected: 'The host did not accept the diagnostic request.',
      startFailed: 'Diagnosis could not start: {msg}',
      createdPromptCopied: 'The diagnostic session was created but the request was not sent. The prompt was copied; paste and send it.',
      createdPromptManual: 'The diagnostic session was created but the request was not sent. Paste the diagnostic prompt in the new session.',
      started: 'Diagnostic session started. It will collect read-only evidence, then explain the cause and prepare a feedback draft.',
    },
  }
  const ENV_LABELS = {
    surface: ['界面', 'Surface'],
    appVersion: ['Remote 版本', 'Remote version'],
    pluginVersion: ['插件版本', 'Plugin version'],
    gatewayVersion: ['网关版本', 'Gateway version'],
    gatewayOk: ['网关状态', 'Gateway health'],
    gatewayReachable: ['上游可达', 'Upstream reachable'],
    dshVersion: ['DSH 版本', 'DSH version'],
    platform: ['平台', 'Platform'],
    host: ['主机', 'Host'],
    mux: ['mux 实时通道', 'mux channel'],
    hostEvents: ['host 实时通道', 'host channel'],
    client: ['客户端', 'Client'],
  }

  let ui = null
  let active = null
  let lastFocus = null
  let retainedSymptom = ''
  let retainedInclude = false

  function language() {
    return root.I18N && root.I18N.lang === 'en' ? 'en' : 'zh'
  }

  function strings() {
    return STRINGS[language()]
  }

  function format(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, (match, key) => vars && vars[key] != null ? String(vars[key]) : match)
  }

  function short(value, max) {
    const text = typeof value === 'string' ? value : value == null ? '' : String(value)
    return text.replace(/\s+/g, ' ').trim().slice(0, max)
  }

  function clip(value, max) {
    const text = typeof value === 'string' ? value : value == null ? '' : String(value)
    return text.trim().slice(0, max)
  }

  function safeJson(value, max) {
    try {
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      return typeof text === 'string' ? text.slice(0, max) : ''
    } catch {
      return ''
    }
  }

  function resolve(value) {
    try { return typeof value === 'function' ? value() : value } catch { return '' }
  }

  function connectionValid(options) {
    try { return !!(options && options.connection && options.connection.valid()) } catch { return false }
  }

  function formatEnvValue(value, max) {
    if (Array.isArray(value) || (value && typeof value === 'object')) return safeJson(value, max)
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    return short(value, max)
  }

  function environmentRows(value, lang) {
    if (value == null || value === '') return []
    if (typeof value === 'string') return [{ label: lang === 'en' ? 'Environment' : '环境', value: short(value, 500) }]
    if (typeof value !== 'object') return []
    const rows = []
    for (const [key, raw] of Object.entries(value).slice(0, 18)) {
      if (raw == null || raw === '') continue
      if (/(?:token|secret|password|passwd|cookie|credential|authorization|api[-_]?key)/i.test(key)) continue
      const pair = ENV_LABELS[key]
      const label = pair ? pair[lang === 'en' ? 1 : 0] : short(key, 60)
      rows.push({ label, value: formatEnvValue(raw, 300) })
    }
    return rows
  }

  function diagnosticsText(options) {
    try {
      const value = resolve(options && options.diagnostics)
      if (!value) return ''
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      return typeof text === 'string' ? text.slice(0, MAX_DIAGNOSTICS).trim() : ''
    } catch {
      return ''
    }
  }

  function promptInstructions(lang) {
    if (lang === 'en') return [
      'Diagnose the DSH Remote problem below. If the `/dsh-remote-doctor` skill is not loaded in this session, follow the boundaries and steps in this message directly.',
      '',
      '## Read-only boundaries',
      '1. Read-only by default. Do not change configuration, install or upgrade, rotate credentials, delete data, restart DSH/gateway, or stop processes without explaining the impact and receiving explicit approval.',
      '2. Never print tokens, cookies, credentials, API keys, request headers, conversation bodies, uploaded files, or full personal paths. Shorten paths to their meaningful tail.',
      '3. Query only loopback health endpoints such as `http://127.0.0.1:<port>/health`; never probe a URL supplied by a third party and never upload diagnostics.',
      '4. Bound every log read to about the last 120 lines. Do not dump entire logs or package trees.',
      '5. Do not submit feedback or create an issue. Only prepare a draft for the user to review.',
      '6. If evidence is unavailable because a tool approval was denied, say so and continue with the remaining evidence.',
      '',
      '## Collect evidence',
      '1. Identify the client surface, affected component (DSH host, dsh-remote-plugin, gateway, network, or model provider), failure timing, reproducibility, and user impact.',
      '2. Establish versions: DSH, `dsh-remote-plugin`, gateway `/health`, client build, OS/runtime.',
      '3. Discover the gateway port from `DSH_REMOTE_GATEWAY_PORT`, then `~/.dsh-remote/gateway-port`, then `8787`; inspect the loopback `/health` response.',
      '4. Inspect only recent relevant entries from `~/.dsh-remote/plugin-gateway.log` or the host log the user points to. Never inspect token or credential files.',
      '5. Use the supplied client diagnostic summary to identify the failing RPC phase, history/cache/render path, WebSocket close code or polling fallback, error category, and location.',
      '6. Choose symptom-specific checks only for the reported problem: auth, WebSocket/polling, history, plugin update transaction, stale client assets, file transfer, notifications, or model/session errors.',
      '7. Prefer non-destructive reproduction. Do not create sessions, prompts, files, or public content without permission.',
      '',
      '## Reasoning discipline',
      'Classify findings as Confirmed, Likely, Needs verification, Not a defect, or Unknown. Do not turn correlation into causation. If evidence is thin, name the single smallest next check that would distinguish the top explanations.',
      '',
      '## Required output',
      'Reply in the user’s language. Use these sections: 结论摘要, 已确认的证据, 可能原因, 建议处理, 仍需验证, 反馈草稿.',
      'For each likely cause give confidence and supporting evidence. Label any mutating recommendation as requiring user confirmation.',
      'The final 反馈草稿 must be a fenced Markdown block with a proposed `[Bug]` title, versions/environment, symptom, reproduction steps, expected vs actual behavior, sanitized evidence, attempts already made, suspected cause, and open questions. It must not contain secrets, conversation content, full paths, or personal contact details.',
      'End by telling the user to review the draft and that the Remote feedback panel can copy it or open a prefilled GitHub issue. Do not submit it yourself.',
    ]
    return [
      '请诊断下面的 DSH Remote 插件问题。若当前会话没有加载 `/dsh-remote-doctor` 技能，请直接按本消息中的边界与步骤执行。',
      '',
      '## 只读边界',
      '1. 默认只读。未解释影响并取得用户明确同意前，不修改配置、不安装/升级、不轮换凭证、不删除数据、不重启 DSH 或网关、不停止进程。',
      '2. 不输出令牌、Cookie、账号凭证、API Key、请求头、对话正文、上传文件或完整个人路径。路径只保留有意义的尾部。',
      '3. 只查询回环健康端点，例如 `http://127.0.0.1:<端口>/health`；不探测第三方提供的 URL，不上传诊断。',
      '4. 每次读取日志最多看最后约 120 行，不倾倒完整日志或依赖树。',
      '5. 不提交反馈、不创建 Issue，只准备一份供用户审阅的草稿。',
      '6. 若工具审批被拒绝导致证据缺失，明确说明，并继续使用剩余证据。',
      '',
      '## 收集证据',
      '1. 先确认客户端界面、受影响的组件（DSH 主机、dsh-remote-plugin、网关、网络或模型服务）、发生时机、复现概率和影响。',
      '2. 核对版本：DSH、`dsh-remote-plugin`、网关 `/health`、客户端 build、操作系统/运行时。',
      '3. 按 `DSH_REMOTE_GATEWAY_PORT`、`~/.dsh-remote/gateway-port`、默认 `8787` 的顺序确定网关端口，读取回环 `/health`。',
      '4. 只查看 `~/.dsh-remote/plugin-gateway.log` 或用户指定主机日志的最近相关条目；不要查看 token、凭证或 Cookie 文件。',
      '5. 使用随消息提供的客户端脱敏诊断摘要，定位失败 RPC 阶段、历史/缓存/渲染路径、WebSocket 关闭码或轮询降级、错误类别和位置。',
      '6. 只按现象选择检查分支：认证、WS/轮询、历史记录、插件更新事务、旧前端资源、文件传输、通知或模型/会话错误。',
      '7. 优先采用无副作用复现。未经许可，不新建会话、不发送 prompt、不创建文件或公开内容。',
      '',
      '## 推理纪律',
      '把结论分为“已确认 / 可能 / 仍需验证 / 非缺陷 / 未知”。不要把相关性写成因果。证据不足时，只提出一个能区分前两种解释的最小检查。',
      '',
      '## 必须的输出',
      '使用用户的语言，按以下结构回复：结论摘要、已确认的证据、可能原因、建议处理、仍需验证、反馈草稿。',
      '每个可能原因都要给出置信度和证据。任何会产生写入或副作用的建议都标注“需你确认”。',
      '最后的“反馈草稿”使用 Markdown 代码块，包含建议的 `[Bug]` 标题、版本/环境、问题现象、复现步骤、期望与实际表现、脱敏证据、已尝试措施、疑似原因和待确认问题。草稿不得包含密钥、对话正文、完整路径或个人联系方式。',
      '结尾提醒用户先审阅草稿，并说明 Remote 反馈面板可以复制草稿或打开预填的 GitHub Issue；不要自行提交。',
    ]
  }

  function buildDoctorPrompt(options) {
    options = options || {}
    const lang = options.lang === 'en' || options.lang === 'zh' ? options.lang : language()
    const symptom = clip(options.symptom, MAX_SYMPTOM)
    const rows = environmentRows(resolve(options.environment), lang)
    const diagnostics = options.includeDiagnostics ? diagnosticsText(options).slice(0, MAX_PROMPT_DIAGNOSTICS) : ''
    const lines = [
      '/dsh-remote-doctor',
      '',
      ...promptInstructions(lang),
      '',
      lang === 'en' ? '## User report' : '## 用户现象',
      symptom || (lang === 'en' ? '(No symptom yet. Ask one focused clarification question before acting.)' : '（用户尚未填写现象。请先只问一个最关键的澄清问题。）'),
      '',
      lang === 'en' ? '## Environment' : '## 环境',
      ...(rows.length ? rows.map(row => `- ${row.label}: ${row.value}`) : ['- unknown']),
    ]
    if(options.target?.kind==='loaded-plugin' || options.target?.kind==='source-workspace') {
      lines.push('',lang==='en'?'## Diagnosis target':'## 诊断目标',
        lang==='en'?'Target: the currently loaded dsh-remote-plugin; source files are not installation evidence.':'诊断对象是当前加载的 dsh-remote-plugin；源码文件不能代替实装证据。',
        options.target.kind==='loaded-plugin'?(lang==='en'?'This session starts in the loaded plugin directory. Inspect package.json here first.':'本会话从实际加载的插件目录启动，先核对当前目录的 package.json。'):(lang==='en'?'This session starts in a user-selected workspace. Establish the running plugin location separately and compare it with this source workspace.':'本会话从用户选择的工作区启动，请另行确认运行插件的位置，再与源码工作区比较。'))
    }
    if (diagnostics) {
      lines.push('', lang === 'en' ? '## Sanitized client diagnostic snapshot' : '## 客户端脱敏诊断摘要', '```text', diagnostics, '```')
    }
    return lines.join('\n').slice(0, 18000)
  }

  function feedbackTitle(options) {
    const symptom = short(options && options.symptom, 90)
    return symptom ? `[Bug] ${symptom}` : '[Bug] DSH Remote plugin issue'
  }

  function buildFeedbackDraft(options) {
    options = options || {}
    const lang = options.lang === 'en' || options.lang === 'zh' ? options.lang : language()
    const symptom = clip(options.symptom, MAX_SYMPTOM)
    const rows = environmentRows(resolve(options.environment), lang)
    const diagnostics = options.includeDiagnostics ? diagnosticsText(options).slice(0, MAX_PROMPT_DIAGNOSTICS) : ''
    const lines = lang === 'en' ? [
      `## Suggested title`,
      feedbackTitle(options),
      '',
      '## What happened',
      symptom || '(Describe the symptom here.)',
      '',
      '## Environment',
      ...(rows.length ? rows.map(row => `- ${row.label}: ${row.value}`) : ['- Unknown']),
      '',
      '## Steps to reproduce',
      '1. ',
      '2. ',
      '3. ',
      '',
      '## Expected behavior',
      '',
      '## Actual behavior',
      '',
      '## Attempts already made',
      '',
    ] : [
      '## 建议标题',
      feedbackTitle(options),
      '',
      '## 问题现象',
      symptom || '（请补充问题现象）',
      '',
      '## 环境',
      ...(rows.length ? rows.map(row => `- ${row.label}: ${row.value}`) : ['- 未知']),
      '',
      '## 复现步骤',
      '1. ',
      '2. ',
      '3. ',
      '',
      '## 期望行为',
      '',
      '## 实际表现',
      '',
      '## 已尝试的措施',
      '',
    ]
    if (diagnostics) {
      lines.push(
        lang === 'en' ? '## Sanitized diagnostic evidence' : '## 脱敏诊断证据',
        '```text',
        diagnostics,
        '```',
        ''
      )
    }
    lines.push(
      lang === 'en' ? '## AI diagnosis (paste the conclusion here)' : '## AI 诊断结论（请粘贴诊断会话的结论）',
      '',
      lang === 'en' ? '<!-- Review and remove anything private before submitting. -->' : '<!-- 提交前请检查并删除不应公开的信息。 -->'
    )
    return lines.join('\n')
  }

  function buildIssueUrl(options) {
    options = options || {}
    const title = short(options.title || feedbackTitle(options), 120)
    const suffix = options.lang === 'en'
      ? '\n\n(Content was shortened; copy the full draft from DSH Remote.)'
      : '\n\n（内容过长，完整草稿请从 DSH Remote 复制。）'
    let body = typeof options.body === 'string' ? options.body : ''
    if (body.length > MAX_ISSUE_BODY) body = body.slice(0, MAX_ISSUE_BODY)
    const base = options.base || GITHUB_NEW_ISSUE
    const make = value => base + '?' + new URLSearchParams({ title, body: value }).toString()
    let url = make(body)
    // Browsers and GitHub reject very long request URLs. Percent-encoding can
    // triple the length of CJK text, so shrink iteratively rather than relying
    // on the character cap alone.
    for (let attempt = 0; attempt < 24 && url.length > 7800 && body.length > 0; attempt += 1) {
      const keep = Math.max(0, Math.floor(body.length * (7800 / url.length)) - 32)
      body = body.slice(0, keep)
      url = make(body + suffix)
    }
    return url
  }

  function copyWith(options, value) {
    const fn = options && typeof options.copy === 'function' ? options.copy : async (text) => {
      try { await root.navigator.clipboard.writeText(text); return true } catch { return false }
    }
    return Promise.resolve(fn(value)).then(ok => ok === true, () => false)
  }

  function toast(options, message, kind) {
    try { options && typeof options.toast === 'function' && options.toast(message, kind) } catch {}
  }

  function button(label, className, handler) {
    const node = root.document.createElement('button')
    node.type = 'button'
    node.className = className || 'doctor-btn'
    node.textContent = label
    node.addEventListener('click', handler)
    return node
  }

  function element(tag, className, text) {
    const node = root.document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
  }

  function setStatus(message, kind) {
    if (!ui) return
    ui.status.textContent = message || ''
    ui.status.dataset.kind = kind || ''
  }

  function currentDiagnosticsText() {
    return active ? diagnosticsText(active) : ''
  }

  function currentPrompt() {
    if (!active) return ''
    return buildDoctorPrompt({
      lang: language(),
      symptom: ui ? ui.symptom.value : retainedSymptom,
      environment: resolve(active.environment),
      diagnostics: active.diagnostics,
      includeDiagnostics: !!(ui && ui.include.checked),
      target: active.target ? {kind:ui.targetSelect.value==='plugin'?'loaded-plugin':'source-workspace',version:active.target.plugin.version} : null,
    })
  }

  function currentDraft() {
    if (!active) return ''
    return buildFeedbackDraft({
      lang: language(),
      symptom: ui ? ui.symptom.value : retainedSymptom,
      environment: resolve(active.environment),
      diagnostics: active.diagnostics,
      includeDiagnostics: !!(ui && ui.include.checked),
    })
  }

  function updateStart(preserveStatus = false) {
    if (!ui || !active) return
    const connected = connectionValid(active) && typeof active.rpc === 'function'
    const symptom = ui.symptom.value.trim()
    ui.start.disabled = !!active.busy || !connected || !symptom || active.targetLoading || (!!active.loadTarget && !active.target)
    ui.targetSelect.disabled = !!active.busy || !!active.targetLoading
    ui.start.textContent = active.busy ? strings().starting : strings().start
    if (!preserveStatus) {
      if (!connected) setStatus(strings().disconnected, 'warn')
      else if (active.targetLoading) setStatus(language()==='en'?'Locating the loaded plugin…':'正在定位当前加载的插件…', '')
      else if (active.loadTarget && !active.target) setStatus(language()==='en'?'Could not locate the plugin. Reopen to retry, or copy the diagnostic prompt.':'无法定位插件目录，请重新打开重试，或复制排查提示词。','err')
      else if (!symptom) setStatus(strings().noSymptom, '')
      else if (!active.busy) setStatus(strings().ready, '')
    }
    ui.include.disabled = !!active.busy
    ui.symptom.disabled = !!active.busy
    ui.copyPrompt.disabled = !!active.busy
    ui.copyDraft.disabled = !!active.busy
  }

  function render() {
    if (!ui || !active) return
    const s = strings()
    ui.overlay.setAttribute('aria-label', s.title)
    ui.title.textContent = s.title
    ui.targetLabel.textContent = language()==='en'?'Diagnosis target':'诊断目标'
    ui.intro.textContent = s.intro
    ui.costTitle.textContent = s.costTitle
    ui.cost.textContent = s.cost
    ui.privacy.textContent = s.privacy
    ui.symptomLabel.textContent = s.symptom
    ui.symptom.placeholder = s.symptomPlaceholder
    ui.includeText.textContent = s.include
    ui.includeHint.textContent = s.includeHint
    ui.envLabel.textContent = s.environment
    ui.detailsSummary.textContent = s.details
    ui.copyDiagnostics.textContent = s.copyDiagnostics
    ui.exportDiagnostics.textContent = s.exportDiagnostics
    ui.copyPrompt.textContent = s.copyPrompt
    ui.copyDraft.textContent = s.copyDraft
    ui.issue.textContent = s.openIssue
    ui.cancel.textContent = s.cancel
    ui.close.setAttribute('aria-label', s.close)
    ui.close.title = s.close
    ui.symptom.maxLength = MAX_SYMPTOM
    if (ui.previewOpen) ui.previewOpen.textContent = s.details
    ui.env.replaceChildren()
    const rows = environmentRows(resolve(active.environment), language())
    if (!rows.length) ui.env.append(element('span', 'doctor-muted', '—'))
    for (const row of rows) {
      const item = element('span', 'doctor-env-item')
      item.append(element('b', null, row.label), root.document.createTextNode(' ' + row.value))
      ui.env.append(item)
    }
    const diagnostics = currentDiagnosticsText()
    ui.preview.textContent = diagnostics || s.noDiagnostics
    ui.copyDiagnostics.disabled = !diagnostics
    ui.exportDiagnostics.disabled = !diagnostics
    setStatus(connectionValid(active) ? s.ready : s.disconnected, connectionValid(active) ? '' : 'warn')
    updateStart()
  }

  async function copyPrompt() {
    const ok = await copyWith(active, currentPrompt())
    setStatus(ok ? strings().promptCopied : strings().copyFailed, ok ? 'ok' : 'err')
  }

  async function copyDraft() {
    const ok = await copyWith(active, currentDraft())
    setStatus(ok ? strings().draftCopied : strings().copyFailed, ok ? 'ok' : 'err')
  }

  async function copyDiagnostics() {
    const text = currentDiagnosticsText()
    if (!text) return setStatus(strings().noDiagnostics, 'warn')
    const ok = await copyWith(active, text)
    setStatus(ok ? strings().diagnosticsCopied : strings().copyFailed, ok ? 'ok' : 'err')
  }

  async function exportDiagnostics() {
    if (active && typeof active.exportDiagnostics === 'function') {
      try {
        await active.exportDiagnostics()
        setStatus(strings().exportStarted, 'ok')
        return
      } catch {}
    }
    await copyDiagnostics()
  }

  function openIssue() {
    const draft = currentDraft()
    const url = buildIssueUrl({ title: feedbackTitle({ symptom: ui.symptom.value }), body: draft, lang: language() })
    const link = root.document.createElement('a')
    link.href = url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.style.display = 'none'
    root.document.body.append(link)
    link.click()
    link.remove()
    setStatus(strings().issueOpened, 'ok')
  }

  async function startDiagnosis() {
    if (!ui || !active || active.busy) return
    const options = active
    const s = strings()
    const symptom = ui.symptom.value.trim()
    if (!symptom) {
      setStatus(s.noSymptom, 'err')
      ui.symptom.focus()
      return
    }
    if (!connectionValid(options) || typeof options.rpc !== 'function') {
      setStatus(s.disconnected, 'err')
      return
    }
    if (options.targetLoading || (options.loadTarget && !options.target)) return
    // Capture exactly what this start approved; a later panel must never
    // supply its contents to an older in-flight request.
    const prompt = currentPrompt()
    const current = () => active === options && connectionValid(options)
    options.busy = true
    updateStart()
    setStatus(s.starting, 'pending')
    let sessionId = ''
    try {
      const location = {}
      const selected = options.target && ui.targetSelect.value !== 'plugin' ? options.target.workspaces[Number(ui.targetSelect.value)] : null
      const workspaceId = options.target ? selected?.workspaceId : resolve(options.workspaceId)
      const cwd = options.target ? selected?.path || options.target.plugin.path : resolve(options.cwd)
      if (workspaceId) location.workspaceId = workspaceId
      else if (cwd) location.cwd = cwd
      const created = await options.rpc('session.create', location)
      if (!current()) return
      sessionId = short(created && created.sessionId, 200)
      if (!sessionId) throw new Error(s.createFailed)
      const value = await options.rpc('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      })
      if (!current()) return
      if (value && value.accepted === false) throw new Error(s.promptRejected)
      close()
      retainedSymptom = ''
      retainedInclude = false
      try { await options.openSession(sessionId) } catch {}
      toast(options, s.started, 'ok')
    } catch (error) {
      if (!current()) return
      options.busy = false
      if (sessionId) {
        const copied = await copyWith(options, prompt)
        if (!current()) return
        close()
        try { await options.openSession(sessionId) } catch {}
        toast(options, copied ? s.createdPromptCopied : s.createdPromptManual, 'err')
      } else if (active === options) {
        setStatus(format(s.startFailed, { msg: short(error && error.message, 240) || 'unknown' }), 'err')
      }
    } finally {
      options.busy = false
      if (active === options && ui) updateStart(connectionValid(options))
    }
  }

  function close() {
    if (!ui) return
    retainedSymptom = ui.symptom.value
    retainedInclude = ui.include.checked
    ui.overlay.classList.add('hidden')
    ui.overlay.setAttribute('aria-hidden', 'true')
    root.document.body.classList.remove('doctor-open')
    active = null
    try { lastFocus && lastFocus.focus && lastFocus.focus() } catch {}
    lastFocus = null
  }

  function ensureUi() {
    if (ui) return ui
    const overlay = element('div', 'doctor-overlay hidden')
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-hidden', 'true')
    const card = element('section', 'doctor-card')
    const head = element('div', 'doctor-head')
    const title = element('h2', 'doctor-title')
    title.id = 'doctor-title'
    overlay.setAttribute('aria-labelledby', title.id)
    const closeButton = button('×', 'doctor-close', close)
    head.append(title, closeButton)
    const intro = element('p', 'doctor-intro')
    const targetField = element('label','doctor-field doctor-target')
    const targetLabel = element('span','doctor-label')
    const targetSelect = element('select','doctor-target-select')
    targetSelect.setAttribute('aria-label',language()==='en'?'Diagnosis target':'诊断目标')
    const targetPath = element('code','doctor-target-path')
    const targetHint = element('small','doctor-muted')
    targetField.append(targetLabel,targetSelect,targetPath,targetHint)
    const notice = element('div', 'doctor-notice')
    const costTitle = element('strong', null)
    const cost = element('p', null)
    const privacy = element('p', 'doctor-privacy')
    notice.append(costTitle, cost, privacy)
    const field = element('label', 'doctor-field')
    const symptomLabel = element('span', 'doctor-label')
    const symptom = element('textarea', 'doctor-textarea')
    symptom.rows = 5
    symptom.setAttribute('autocomplete', 'off')
    field.append(symptomLabel, symptom)
    const envLabel = element('div', 'doctor-label doctor-env-label')
    const env = element('div', 'doctor-env')
    const includeLabel = element('label', 'doctor-include')
    const include = element('input')
    include.type = 'checkbox'
    const includeText = element('span')
    const includeHint = element('small', null)
    includeLabel.append(include, includeText, includeHint)
    const details = element('details', 'doctor-details')
    const detailsSummary = element('summary')
    const detailsBody = element('div', 'doctor-details-body')
    const preview = element('pre', 'doctor-preview')
    const diagnosticActions = element('div', 'doctor-diagnostic-actions')
    const copyDiagnosticsButton = button('', 'doctor-btn small', () => { void copyDiagnostics() })
    const exportButton = button('', 'doctor-btn small', () => { void exportDiagnostics() })
    diagnosticActions.append(copyDiagnosticsButton, exportButton)
    detailsBody.append(preview, diagnosticActions)
    details.append(detailsSummary, detailsBody)
    const status = element('p', 'doctor-status')
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    const actions = element('div', 'doctor-actions')
    const copyPromptButton = button('', 'doctor-btn', () => { void copyPrompt() })
    const copyDraftButton = button('', 'doctor-btn', () => { void copyDraft() })
    const issueButton = button('', 'doctor-btn', openIssue)
    const cancel = button('', 'doctor-btn ghost', close)
    const start = button('', 'doctor-btn primary', () => { void startDiagnosis() })
    actions.append(copyPromptButton, copyDraftButton, issueButton, start, cancel)
    card.append(head, intro, targetField, notice, field, envLabel, env, includeLabel, details, status, actions)
    overlay.append(card)
    root.document.body.append(overlay)
    overlay.addEventListener('click', event => { if (event.target === overlay) close() })
    symptom.addEventListener('input', () => {
      retainedSymptom = symptom.value
      updateStart()
    })
    include.addEventListener('change', () => {
      retainedInclude = include.checked
    })
    targetSelect.addEventListener('change',()=>{
      if(!active?.target)return
      const row=targetSelect.value==='plugin'?active.target.plugin:active.target.workspaces[Number(targetSelect.value)]
      targetPath.textContent=row?.path || ''
    })
    root.document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !overlay.classList.contains('hidden')) close()
    })
    ui = {
      overlay, title, close: closeButton, intro, costTitle, cost, privacy,
      targetField,targetLabel,targetSelect,targetPath,targetHint,
      symptomLabel, symptom, envLabel, env, include, includeText, includeHint,
      details, detailsSummary, preview, previewOpen: detailsSummary, copyDiagnostics: copyDiagnosticsButton, exportDiagnostics: exportButton,
      status, actions, copyPrompt: copyPromptButton, copyDraft: copyDraftButton, issue: issueButton,
      cancel, start,
    }
    return ui
  }

  function open(options) {
    if (!root.document || !root.document.body) return false
    const opts = options || {}
    if (active) active.busy = false
    active = { ...opts, busy: false }
    lastFocus = root.document.activeElement
    ensureUi()
    ui.symptom.value = retainedSymptom || ''
    ui.include.checked = retainedInclude
    ui.targetField.hidden = typeof opts.loadTarget !== 'function'
    ui.targetSelect.replaceChildren()
    ui.targetPath.textContent = ''
    if(typeof opts.loadTarget==='function') {
      const owner=active;owner.targetLoading=true
      ui.targetHint.textContent=language()==='en'?'Uses the installed plugin by default. A source workspace is checked against the running installation.':'默认使用实际加载的插件目录；选择源码工作区时，仍会核对运行实例与安装包。'
      Promise.resolve().then(()=>opts.loadTarget()).then(target=>{
        if(active!==owner || !connectionValid(owner))return
        if(target?.ok!==true || target.schema!==1 || typeof target.plugin?.path!=='string' || !target.plugin.path || !Array.isArray(target.workspaces))throw Error('invalid-target')
        owner.target=target
        const add=(value,text)=>{const option=element('option',null,text);option.value=value;ui.targetSelect.append(option)}
        add('plugin',language()==='en'?'Loaded Remote plugin (recommended)':'已加载的 Remote 插件（推荐）')
        target.workspaces.forEach((row,index)=>add(String(index),(language()==='en'?'Workspace · ':'工作区 · ')+(row.title||row.path)))
        ui.targetSelect.value='plugin';ui.targetPath.textContent=target.plugin.path
        const registered=target.skill?.status==='registered'
        ui.targetHint.textContent+=(registered?(language()==='en'?' Doctor skill registered.':' Doctor 技能已注册。'):(language()==='en'?' Skill registration unconfirmed; the full prompt remains available.':' 技能注册尚未确认，可使用完整提示词兜底。'))
      }).catch(()=>{}).finally(()=>{if(active===owner){owner.targetLoading=false;updateStart()}})
    }
    render()
    ui.overlay.classList.remove('hidden')
    ui.overlay.setAttribute('aria-hidden', 'false')
    root.document.body.classList.add('doctor-open')
    setTimeout(() => { try { ui.symptom.focus() } catch {} }, 40)
    return true
  }

  const api = {
    open,
    close,
    buildDoctorPrompt,
    buildFeedbackDraft,
    buildIssueUrl,
    feedbackTitle,
    diagnosticsText,
    environmentRows,
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.DshDoctor = api
})(typeof window === 'undefined' ? globalThis : window)
