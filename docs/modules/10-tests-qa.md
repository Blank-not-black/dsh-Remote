# 测试与真实场景 QA 模块

> 源码核对：2026-10-12，仓库 0.7.4；源码能力与历史验收分开说明。[文档首页](../README.md)。

> 状态：现行质量门禁
>
> 代码范围：`tests/*.test.js`、`tests/fixtures/realistic-stack.cjs`

## 1. 模块定位

测试模块负责证明功能、协议、安全、生命周期和跨端契约没有回归。它不是“把测试跑绿”这么简单，还要区分隔离模拟、真实本机生命周期、浏览器 UI 静态检查和 Android 真机验证。

## 2. 代码结构

| 测试类别 | 主要文件 |
| --- | --- |
| 网关 HTTP/WS/文件/公告 | `gateway.test.js` |
| 上传重试、暂停与连接归属 | `upload-ui.test.js`、`upload-safety.test.js` |
| 写操作收据、视觉桥及错误归属 | `receipt-errors.test.js`、`workflow-reliability.test.js`、`vision-bridge.test.js`、`session-runtime-ui.test.js` |
| Windows 原生文件网关 | `windows-files.test.js`、`windows-gateway.test.js`、`.github/workflows/windows-files.yml` |
| DSH 重启和网关恢复 | `lifecycle.test.js` |
| HTTP/WS/RPC 全链路 | `user-flows.test.js`、`realistic-stack.cjs` |
| 跨端网络与 UI 契约 | `network-regression.test.js` |
| 插件运行与自启 | `plugin-runtime.test.js`、`plugin-autostart.test.js` |
| 会话/思考/工作区/文件 UI | `session-list-ui.test.js`、`reasoning-ui.test.js`、`workspace-*` |
| 管理/公告/更新/设备 | `doctor-ui.test.js`、`device-keys*`、`announcement-poll-ui.test.js`、`app-gateway-version-ui.test.js` |
| 模型配置 | `model-settings.test.js` |
| Markdown、统计、转写、通知 | `md.test.js`、`stats.test.js`、`transcribe-core.test.js`、`mobile-select-peak-reminder.test.js`、`asr-test-ui.test.js` |

## 3. 当前功能

- Node 内置 `node:test`、`assert`、`fetch`，不引入测试依赖。
- 静态源码契约测试：确认关键函数、字段和安全规则没有被删除。
- 隔离子进程：临时 HOME、临时文件根、固定 token、清代理变量和可靠清理。
- Fake DSH HTTP/WS、Fake feedback collector 和真实网关子进程组合测试。
- 生命周期测试覆盖 DSH 停启、网关重启、客户端 WS 恢复、事件重放和文件继续可用。

## 4. 具体实现方式

`realistic-stack.cjs` 创建临时目录、可控制的 DSH HTTP/WS、网关和客户端模拟器，并记录 RPC、prompt、response、feedback。测试应通过公开 HTTP/WS 行为验证，不直接调用业务内部私有变量。

静态 UI 测试适用于零构建前端：读取根源码，用正则或 `vm` 提取纯函数验证行为。对于二维码多地址，测试同时执行 `admin.js` 的 `pairTarget()` 和 `app.js` 的 `applyPairUrl()`，证明生成端和消费端契约一致。

Windows 文件测试分为两层：`windows-files.test.js` 用 `path.win32` 和前端纯函数覆盖盘符根、大小写、正反斜杠、UNC share、跨根拒绝和服务器切换清理；`windows-gateway.test.js` 在 `windows-latest` 上使用临时 `USERPROFILE`、固定 token 和两个临时授权根真实启动网关，覆盖默认根、分号多根、大小写、中文/空格路径、下载、上传、预览、建目录、跨根拒绝和 junction 逃逸。CI 仍不能替代 Windows RC 对真实盘符权限与 UNC 凭据的检查。

真实生命周期测试使用固定端口的可重启假 DSH，模拟 DSH 消失/恢复和网关重启；验收必须看事件通道状态，不只看 HTTP 200。

`restart-connectivity.test.js` 实际替换隔离网关进程及关闭/重开假上游 HTTP/WS，验证既有配对、短期 WS 票据、事件 epoch 重置和已确认的分支仍可读取。`desktop-recovery.test.js` 另模拟响应正文不结束且忽略 abort 的客户端，确认票据和长轮询的整个读取有截止时间、迟到正文不能覆盖新状态。`turn-results.test.js` 验证分支创建成功后不等待会话列表刷新才打开。它们不能替代真实手机、系统重启或现场网络故障的复测。

`upload-ui.test.js` 执行手机上传控制器与实际 SHA-256 实现，覆盖空文件覆盖冲突、服务端纠正续传偏移后的前缀重算、切换主机后的迟到探测、无效偏移、探测正文超时、重复继续、持续偏移冲突及旧取消请求不能清除新任务。Desktop 实装插件生命周期测试将 pnpm store 与 APPDATA/LOCALAPPDATA 也指向临时目录，避免依赖用户缓存或写入盘符根目录。

`receipt-errors.test.js` 区分未知收据的网络、超时、上游 HTTP 和响应结构错误，校验日志/落盘不保存请求正文或上游错误原文，并实际重启网关验证诊断保留、重复 POST 不重发上游。视觉桥专项覆盖 strictReceipt 准备失败与再次提交失败的不同分类。`session-runtime-ui.test.js` 保留每个会话的错误，只为当前会话弹出提示；真实 DSH 观察测试包含缺失 Auto 集成的冷会话，验证读取历史不激活它，显式恢复会得到原始权限错误，其他新会话仍可正常创建。

新增重点回归：connection-isolation/desktop-async-regressions 验证迟到读写与 finally 归属；health-latency 验证后台快照；weak-network 验证 gzip、ETag 与独立长轮询；crash-recovery/history-ui/refresh-efficiency 验证恢复、缓存与增量行为；dsh-020-compat 验证 Inbox/job roster 和归档回执；harmonyos-context 验证 ArkTS 控制器方法而非 ArkUI 真机派发。

真实安装测试按环境显式启用：DSH_TEST_CLI_ROOT，洞察另需 DSH_TEST_INSIGHTS_ROOT，Desktop 需同一安装的 DSH_TEST_DESKTOP_EXE 与 DSH_TEST_DESKTOP_CLI。默认跳过不是对应能力已实测。compat workflow 测已发布 npm 插件的安装挂载，release workflow 只复用 Windows 文件门禁，不替代全量本地测试。

## 5. 制作目的

- 捕捉重启、降级、恢复、旧版本兼容和安全边界问题。
- 让跨端协议变化有明确的生产者/消费者测试。
- 用隔离环境保护真实用户配置、token、文件和运行中的 DSH 服务。

## 6. 接口与数据契约

测试代码通过公开 HTTP/WS、文件和模拟的 DSH context 验证模块；测试夹具的记录对象、固定 token、临时 HOME 和测试端口属于隔离契约，不得连接真实用户配置。

## 7. 门禁与报告

最低门禁：

```text
npm run sync-plugin
npm run check
git diff --check
```

Windows 文件专项门禁由 `.github/workflows/windows-files.yml` 在 main、Pull Request 和手动触发时运行；`release-build.yml` 通过 `workflow_call` 复用同一门禁，正式资产构建必须等待 Windows 文件测试成功：

```text
npm run test-windows-files
```

macOS 的 `macos-files.yml` 在 Apple Silicon / Node 22 上执行全量检查；主发布与手动预览通过 `macos-build.yml` 复用该门禁，并对已签名的 arm64 单文件网关运行 `scripts/smoke-gateway.mjs`。主发布等待 macOS 成功后才汇总所有平台资产并生成校验和，失败不会继续发布。独立网关产物验证不替代 npm 插件在实际 DSH/macOS 中的集成验收。

报告必须说明：修改文件、测试通过/失败/跳过数量、是否构建、是否安装、是否重启真实服务、是否提交/发布，以及自动化无法覆盖的真机项。

- `tests/onboarding.test.js` 执行逐步教学组件与发送控制器：真实状态放行、连接/会话隔离、仅 accepted 完成、示例不代发、不覆盖草稿、暂停与断点恢复、收起、跳过、弹窗优先、分支不可用解释、存储失效、中英文切换及可选引导异常不影响发送。详见[逐步引导](../onboarding-guided-practice.md)。

## 8. 边界与禁止事项
- 测试不得写入真实 `~/.dsh-remote`。
- 不用 `pkill -f` 清理测试或真实网关。
- 不把 sandbox 网络/进程结果冒充宿主机真实状态。
- 不向生产反馈/投票源提交测试数据。
- 不用静态测试声称相机、Android 通知、后台服务或真实多网卡已验证。
- 新功能至少补正常、错误/拒绝、恢复或兼容路径中与其相关的部分。
- 模型配置至少检查提供方/设置读取、只写凭据、模型目录编辑、模型发现、模型级思考档位增删/默认值、非法或重复档位拒绝，以及只读/错误状态。
- asr-test-ui 当前确认 Android 功能测试导航仍在、ASR 页面与原生桥已移除；鸿蒙 ASR 单独做系统权限与真机测试。

## 9. 二维码功能验收矩阵

| 场景 | 期望 |
| --- | --- |
| 多个不同 LAN IP | 一个二维码包含全部 `server` 参数 |
| 重复 LAN IP | 生成端去重，App 不重复保存 |
| 只有 loopback/空列表 | 使用 host/页面主机回退 |
| 旧单地址二维码 | 仍能成功配对 |
| token 缺失/地址非法 | 拒绝，不污染本地状态 |
| 扫码完成 | 第一个地址为当前连接，其余地址在列表中 |

## 10. 修改前检查清单

- 先读对应测试，再改源码。
- 是否要新增纯函数测试，避免只测字符串存在？
- 测试环境是否完全隔离并可清理？
- 是否需要真实生命周期或真机验证？
- 是否会因同步脚本产生额外产物差异？

## 11. 未决事项

- 当前 UI 大部分使用静态源码测试，未来若引入浏览器自动化，需要先评估依赖、运行环境和与零新增依赖约束的兼容性。

历史变更见[模块历史记录](../archive/module-changes.md)。
