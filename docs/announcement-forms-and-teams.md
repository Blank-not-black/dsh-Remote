# 公告表单与智能体团队适配

本次为未提交的本地改动，基于 `0.8.0-rc.3`。没有改动中央公告、正式 APK、更新清单或线上安装。

后续补充的 Android 峰谷通知、后台状态和新 issue 处理，以及包含全部改动的最新 APK，见[峰谷通知与 issue #18](peak-reminders-and-issue18.md)。本文件下方 APK 为公告/团队阶段的中间测试包。

## 公告表单

手机 WebUI 与 Android 共用公告界面，支持旧单选投票、填空、多选及混合问卷。必填、字数、选项数量在前端和网关共用同一校验实现。翻页保留内存草稿；成功提交后才标记提交与已读，持久化提交标记不保存填空内容。关闭后同一页面仍可找回草稿，重新加载页面不保留未提交草稿。

现有 `poll.options` 单选格式不变。新问卷示例（放入公告的 `poll`）：

```json
{
  "id": "experience-2026-10",
  "question": "使用体验反馈",
  "questions": [
    { "id": "suggestion", "type": "text", "question": "希望改进什么？", "maxLength": 300 },
    {
      "id": "features", "type": "multiple", "question": "常用功能",
      "minSelections": 1, "maxSelections": 2,
      "options": [
        { "id": "chat", "label": "对话" },
        { "id": "files", "label": "文件" },
        { "id": "teams", "label": "团队" }
      ]
    },
    {
      "id": "platform", "type": "single", "question": "使用平台", "required": false,
      "options": [{ "id": "android", "label": "Android" }, { "id": "web", "label": "浏览器" }]
    }
  ]
}
```

单题也可直接使用 `poll.type: "text"` 和 `maxLength`，或 `poll.type: "multiple"`、`options`、`minSelections/maxSelections`。`required` 默认 true。最多 8 题、每题 2–12 个选项；填空默认 600 字、上限 1200 字。整个编码后的反馈消息上限 2000 字符，超限在发出前提示精简，以兼容现有收集器。

网关把答案规范化为 `answers: [{questionId,text}|{questionId,optionIds}]`，并完整写进 `POLL {…}` 消息。旧收集器即使只保留 message，也可用 `node scripts/summarize-polls.mjs feedback.jsonl --json` 分题统计。旧单选仍按 optionId 汇总。

旧单选的公网兜底保持兼容。含填写内容的新表单只提交当前连接的网关，失败时保留草稿，不自动向固定公网地址发送填空内容。未读弹窗、确认去重、30 秒检查与版本提醒优先顺序保持原有行为。旧客户端不会识别混合问卷；发布时需按正式交付的客户端版本设置 `minAppVersion`，不要把这次未发布的本地能力当作已有 rc.3 用户均已具备。

公共校验源是 `public/announcement-forms.js`。`npm run sync-plugin` 会将工厂函数内嵌进单文件网关并同步插件产物；`npm run check` 会核对内嵌代码与源一致。

## 智能体团队

手机和桌面入口：更多 → 主机插件 → 已安装的智能体团队 → 查看智能体团队。仅插件配置启用且运行时 active 时显示入口。

对接官方 `@nanmicoder/dsh-agent-teams` 的 `/plugins/dsh-agent-teams/state` 及 `?archived=1`；已用发布包 `0.1.24-rc.1` 的真实快照生成代码验证。来源：[官方仓库](https://github.com/NanmiCoder/dsh-agent-teams)。

可查看团队、成员、任务依赖、受阻状态、交付检查和队长未读消息预览；支持打开队长会话、核对成员目录后打开成员记录。成员记录沿用子代理查看与返回逻辑。计划、派工、任务修改和调度仍由主机团队插件操作，本适配提供只读查看及会话入口。

认证桥接 `/remote/api/teams` 只允许 GET。工作区必须已登记，以队长 sessionId 是否属于工作区成员集合筛选，不用可能重复的工作区名称匹配。固定请求本机插件路由；不接受客户端路径，不转发客户端 Cookie，不返回 executionPrompt、配置或密钥。响应最多 2 MiB，最多显示 40 个团队、每队 100 成员/300 任务、5 条消息预览。

切换工作区或归档视图会清除旧结果并取消旧请求；迟到响应不能覆盖新工作区。正常刷新保留展开状态，刷新失败保留同一工作区的上次结果并显示失败提示；离开页面取消请求和刷新计时器。

## 操作验证

| 操作 | 结果与证据范围 |
| --- | --- |
| 公告启动自动弹出、空填空、超额多选 | 隔离网关 + 390px 浏览器验证；空答案/超额提交未进入本地收集器 |
| 填写→下一条→上一条→提交 | 草稿保留；收集器准确记录一次完整答案；成功后控件禁用 |
| 公告连续点击、切换连接后的迟到成功、表单 401 | 回归测试通过；不错误标记已读，不向公网兜底发送填空 |
| 团队插件入口、切工作区、归档、任务/消息展开 | 手机和桌面浏览器使用隔离的官方格式快照验证；同名异工作区团队不泄漏 |
| 从插件页打开成员→返回队长、发送普通消息、新建会话、文件导航 | 隔离浏览器操作通过；新建会话保留工作区选择，成员保持子代理查看方式 |
| 团队桥接认证、设备权限、方法/参数限制 | 真实 HTTP 网关/插件桥接测试通过；上游为本地测试服务 |
| 发布版团队快照、DSH 会话/分支/子代理兼容 | `0.1.24-rc.1` 发布包快照与已安装 DSH `0.2.1-rc.1` 在临时目录通过；没有启动真实模型任务 |
| 审批/提问、附件、上传下载、反馈、未读去重、重连与操作回执 | 现有用户流、网络、文件和公告测试全部通过；不代表手机真机全部人工验收 |

操作检查中修复：手机团队页取错工作区状态字段、插件页成员入口被“当前必须是队长”限制拦截、公告提交中翻页的按钮状态，以及浏览器断线降级轮询把原生计时器绑定到类实例导致 `Illegal invocation`。

最终 `npm run check`：623 项，614 通过，9 跳过，0 失败。另启用真实 DSH 与发布版团队包的两项可选检查：2 通过、0 跳过。插件同步完成，APK Debug 构建、签名校验与内嵌资源逐字节比对通过。Android 真机、正式安装中的团队调度、鸿蒙客户端未在本次验证。

测试产物：`dist/forms-teams-2026-10-18/dsh-remote-0.8.0-rc.3-forms-teams.apk`；versionCode 8003，Android versionName `0.8.0.rc.3`，SHA-256 `7a80f12fa9d5d0693889e57e9900627d3d6da81a8c6b96d0bb331ba6baf92de8`。同版本本地测试包，非新发布版本。

## 本轮文件清单

- 公告：`public/announcement-forms.js`、`public/app.js`、`public/index.html`、`public/workflow.css`、`gateway.js`、`scripts/embed-announcement-forms.mjs`、`scripts/summarize-polls.mjs`。
- 团队：`public/teams.js`、`public/extensions.js`、`public/desktop/desktop.js`、`public/desktop/desktop.html`、`packages/plugin/teams.mjs`、`packages/plugin/index.mjs`、`packages/plugin/package.json`。
- 同步与检查：`package.json`、`scripts/sync-plugin.mjs`、`scripts/sync-standalone.mjs`、`public/network.js`。插件 `public/` 对应副本及 `gateway.cjs` 由同步脚本生成。
- 测试：`tests/announcement-forms.test.js`、`tests/teams.test.js`、`tests/teams-published.test.js`、`tests/fixtures/teams-data.cjs`、`tests/fixtures/insights-upstream.mjs`、`tests/insights-bridge.test.js`、`tests/extensions-ui.test.js`、`tests/network-regression.test.js`、`tests/network-policy.test.js`、`tests/poll-summary.test.js`。
- 文档：本文件和 `docs/usage.md`。先前回合的会话结果栏、分支显示等未提交改动保留，另见 `docs/turn-results.md`。所有改动均未暂存、未提交。
