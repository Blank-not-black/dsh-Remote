DSH Remote 是一套面向 DeepSeek Harness 的远程控制台，由 DSH 插件、零依赖单文件网关和 Android App / WebUI 组成。

项目地址：https://github.com/Blank-not-black/dsh-Remote

安装命令：

```sh
dsh plugin --profile web add dsh-remote-plugin
```

它主要解决的是“DSH 在电脑上运行，但人暂时离开电脑”的场景：

- 在手机或另一台电脑查看、继续和管理 DSH 会话；
- 处理审批、提问、目标和后台任务；
- 浏览工作区文件，预览常见文本与 Markdown，并传输图片和附件；
- 通过局域网或 Tailscale 连接，不强制依赖中心账号；
- 查看网关、DSH 上游、实时通道、设备连接、Token 与费用统计；
- 网络波动时使用 WebSocket 重连与轮询降级，恢复后自动切回实时通道。

连接凭证使用 Token 鉴权。建议只在可信局域网或 Tailscale 中开放网关端口，不要把端口和令牌直接公开到公网。

当前正式版：v0.6.12

正式版下载：https://github.com/Blank-not-black/dsh-Remote/releases/latest

问题反馈：https://github.com/Blank-not-black/dsh-Remote/issues

项目仍在持续迭代，尤其欢迎开发者反馈 DSH 版本兼容、网关生命周期、移动端交互、附件传输和实时链路方面的问题。如果这个项目刚好解决了你的使用场景，也欢迎 Star，让更多需要远程处理 DSH 会话的人更容易找到它。
