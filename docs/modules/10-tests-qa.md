# 测试与真实场景 QA 模块

> 状态：现行质量门禁
>
> 代码范围：`tests/*.test.js`、`tests/fixtures/realistic-stack.cjs`

## 1. 模块定位

测试模块负责证明功能、协议、安全、生命周期和跨端契约没有回归。它不是“把测试跑绿”这么简单，还要区分隔离模拟、真实本机生命周期、浏览器 UI 静态检查和 Android 真机验证。

## 2. 代码结构

| 测试类别 | 主要文件 |
| --- | --- |
| 网关 HTTP/WS/文件/公告 | `gateway.test.js` |
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

报告必须说明：修改文件、测试通过/失败/跳过数量、是否构建、是否安装、是否重启真实服务、是否提交/发布，以及自动化无法覆盖的真机项。

## 8. 边界与禁止事项

- 测试不得写入真实 `~/.dsh-remote`。
- 不用 `pkill -f` 清理测试或真实网关。
- 不把 sandbox 网络/进程结果冒充宿主机真实状态。
- 不向生产反馈/投票源提交测试数据。
- 不用静态测试声称相机、Android 通知、后台服务或真实多网卡已验证。
- 新功能至少补正常、错误/拒绝、恢复或兼容路径中与其相关的部分。
- 模型配置至少检查提供方/设置读取、只写凭据、模型目录编辑、模型发现、模型级思考档位增删/默认值、非法或重复档位拒绝，以及只读/错误状态。
- ASR 功能测试至少检查 Android 页面入口、录音权限、RecognitionService 查询、系统识别可用性、partial/final/error 回调、session 重建、停止释放和日志复制；不把静态契约测试当作小米真机结果。

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

### 2026-08-26：模型级思考档位测试
- 需求：覆盖自定义模型思考档位的编辑、保存和选择契约。
- 方案：在模型设置静态测试中检查档位字段、增删动作、默认值和校验逻辑。
- 联动：同步检查手机源文件与插件产物，桌面端继续由推理菜单测试覆盖。
- 验证：`tests/model-settings.test.js` 新增档位契约断言，随后执行全量测试。
- 未做：没有把静态测试当作第三方真实 API 或 Android 真机验证。

### 2026-08-27：Android ASR 诊断测试
- 需求：让用户在小米手机上执行一次真实系统 ASR 测试并把日志回传。
- 方案：静态检查 `NativeAsrTest` bridge、Manifest 权限/queries、页面按钮、事件回调和报告复制。
- 联动：Android 编译验证原生 Java；真机验证回调、网络依赖、session 重建和麦克风释放。
- 验证：本地静态测试通过后运行 `npm run build-app`；用户日志作为真实小米能力证据。
- 未做：不通过测试夹具伪造系统 ASR 回调，不上传测试日志。

### 2026-08-27：小米 ASR 权限错误回归
- 真实设备报告出现 `ERROR_INSUFFICIENT_PERMISSIONS` 后，补充 AppOps/全局麦克风状态采集、系统权限设置跳转和 `EXTRA_CALLING_PACKAGE` 契约检查。
- 补充小米语音引擎设置入口契约；不把“已找到 `com.xiaomi.mibrain.speech`”误判为“用户已完成小米隐私授权”。
- 结论更新：小爱官方鉴权 SDK、唤醒 SDK 和小爱 SDK 需要另行平台配置；系统 `SpeechRecognizer` 的真机测试不能替代正式 SDK 接入验收。
- 真机复测顺序：系统设置允许 DSH Remote 麦克风 → 打开全局麦克风 → 完成小米/系统语音服务首次授权 → 回到功能测试重新运行并复制完整日志。

## 11. 未决事项

- 当前 UI 大部分使用静态源码测试，未来若引入浏览器自动化，需要先评估依赖、运行环境和与零新增依赖约束的兼容性。
