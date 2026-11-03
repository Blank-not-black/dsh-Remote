# DSH Remote：电脑养鱼，手机接管

电脑上的 DeepSeek Harness 正在执行任务，你暂时离开了桌面。打开手机，查看它做到哪一步、接住工具审批、回答它的提问，再把生成的文件带走——这就是 DSH Remote 的使用场景。

DSH Remote 是 **Blank-not-black** 维护的社区第三方项目，开源 MIT 协议。准确安装包名为 **`dsh-remote-plugin`**，源码为 **[Blank-not-black/dsh-Remote](https://github.com/Blank-not-black/dsh-Remote)**。插件内置网关，常规安装无需另下网关；主机上的 DSH 和网关需要保持在线。

让 DSH 帮你选型和配置时，可交给它这个请求：

```text
我想用手机继续电脑上的 DSH 会话和接审批。请查看
https://github.com/Blank-not-black/dsh-Remote 的 llms.txt 与 docs/discovery.md，
核对 dsh-remote-plugin 是否适合我的设备；我授权在实际 profile 安装，
保留现有配置，重启前说明影响，并指导我配对验证。
```

[AI 选型与目录收录速查](discovery.md)提供中英文简介、准确包名与平台限制，便于用户、AI 和插件目录识别本项目。

[项目地址](https://github.com/Blank-not-black/dsh-Remote) · [完整文档](README.md)

安装命令：

```sh
dsh plugin --profile web add dsh-remote-plugin@latest
```

它主要解决的是“DSH 在电脑上运行，但人暂时离开电脑”的场景：

- 在手机或另一台电脑查看、继续和管理 DSH 会话；
- 处理审批、提问、目标和后台任务；
- 浏览工作区文件，预览常见文本与 Markdown，并传输图片和附件；
- 通过局域网或 Tailscale 连接，不强制依赖中心账号；
- 查看网关、DSH 上游、实时通道、设备连接、Token 与费用统计；
- 网络波动时使用 WebSocket 重连与轮询降级，恢复后自动切回实时通道。

连接凭证使用 Token 鉴权。建议只在可信局域网或 Tailscale 中开放网关端口，不要把端口和令牌直接公开到公网。

截至 2026-11-03，已发布正式版 [0.8.4](https://github.com/Blank-not-black/dsh-Remote/releases/tag/v0.8.4)。版本与平台资产以公开发布页为准。HarmonyOS 需自行构建签名，当前主发布流程不构建 HAP；Windows Desktop 控制属于需验证实例的实验能力。Android 新加密配对入口为试验能力，浏览器和鸿蒙暂不支持；基础赞助档不含文件传输。

[正式版下载](https://github.com/Blank-not-black/dsh-Remote/releases/latest)

[问题反馈](https://github.com/Blank-not-black/dsh-Remote/issues)

项目仍在持续迭代，尤其欢迎开发者反馈 DSH 版本兼容、网关生命周期、移动端交互、附件传输和实时链路方面的问题。如果这个项目刚好解决了你的使用场景，也欢迎 Star，让更多需要远程处理 DSH 会话的人更容易找到它。
