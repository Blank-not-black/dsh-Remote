# 安装与首次连接

[文档首页](README.md) · [故障排查](troubleshooting.md)

## 选择安装方式

| 场景 | 方式 |
| --- | --- |
| 已使用 DSH Web | 安装 `dsh-remote-plugin`，由插件管理内置网关 |
| 使用 DSH Desktop | 从桌面版自带插件管理入口安装 Remote，再完整退出并重开 Desktop |
| 需要单独管理网关 | 下载 Windows/Linux 单文件网关，或从仓库运行 `node gateway.js --supervise` |
| 手机访问 | Android APK 或手机浏览器连接网关；HarmonyOS 需自行构建、签名 |
| 另一台电脑访问 | 浏览器打开网关地址，进入桌面 WebUI |

网关运行在 DSH 主机或能访问 DSH 上游的机器上。Android/HarmonyOS 客户端本身不启动主机上的 DSH。主机和网关需保持在线。

## DSH Web 插件安装

先确认当前 DSH Web 能正常打开，在运行 DSH 的同一用户下执行：

```sh
dsh plugin --profile web add dsh-remote-plugin@latest
dsh plugin --profile web list --depth 0
```

`web` 是上述示例的目标 profile；自定义 profile 请使用实际名称。Desktop 使用桌面版自身的安装入口，不把 Web profile 的安装结果当作 Desktop 安装成功。

1. 完整重启 DSH Web。手动运行时停止旧进程后重新运行；已有 systemd 用户服务时可使用 `systemctl --user restart dsh-web`。
2. 浏览器 Ctrl+F5 强刷，从 DSH 侧栏打开 DSH Remote。
3. 在插件面板确认网关状态，必要时点击启动；默认端口 8787。
4. 在主机访问 `http://127.0.0.1:8787/health`。返回 JSON 表示网关能响应；还需确认上游和实时通道。
5. 从管理控制台生成配对二维码。在 Android 或已安装的 HarmonyOS 客户端「设置 → 服务器」扫码，也可手动填主机地址与令牌。
6. 手机上使用 `http://电脑局域网IP:8787` 或互通的 Tailscale 地址。手机的 `127.0.0.1`/`localhost` 指向手机自己。

多网卡主机可在管理页勾选要写入二维码的地址。多个 `server` 参数会导入多个连接地址，令牌绑定各地址。使用独立设备密钥时，为设备生成其专用二维码。

RC 使用 `dsh-remote-plugin@next`，稳定版使用 `@latest`。固定版本使用 `@<已发布版本>`。标签当前指向需要查询 npm，不能根据本地版本推断。

Git 源安装示例：

```sh
dsh plugin --profile web add "github:Blank-not-black/dsh-Remote#main&path:/packages/plugin"
```

Git 源安装包含仓库中已同步的插件产物；它与某个公开 Release 的 APK 是否一致需要单独核对。

## 独立网关

从 [GitHub Releases](https://github.com/Blank-not-black/dsh-Remote/releases) 获取对应平台资产。正式版入口为 [Latest](https://github.com/Blank-not-black/dsh-Remote/releases/latest)，RC 在发布列表中单独选择。

Linux：

```sh
chmod +x dsh-remote-linux-x64
./dsh-remote-linux-x64 --supervise
```

Windows PowerShell：

```powershell
.\dsh-remote-win-x64.exe --supervise
```

源码方式需要可运行本项目的 Node.js；项目 CI 使用 Node 22：

```sh
node gateway.js --supervise
```

默认监听 `0.0.0.0:8787`，上游为 `http://127.0.0.1:3080`。管理页为 `/admin`。更改上游或监听端口见[配置参考](configuration.md)。直接运行不带 `--supervise` 的网关不会获得进程监督；`npm start` 与插件启动路径会启用监督。

新 DSH 使用登录会话 Cookie 时，插件负责兑换并写入本地 Cookie 文件。独立运行时若上游需要登录，应使用对应的主机认证配置；仅有 Remote 令牌不能替代 DSH 上游的登录凭证。不要公开 Cookie 内容。

## 安装客户端

- Android：下载 `dsh-remote.apk`，按系统提示允许该来源安装。升级需要一致签名；通知、相机与后台权限按实际使用授予。
- 浏览器：打开网关地址并输入令牌，不需要安装 APK。
- HarmonyOS：参见[自构建与签名指南](harmonyos-self-build.md)。当前发布工作流不构建 HAP，未签名 HAP 不能直接作为可安装包。

配对二维码包含凭证，不能公开截图。优先使用可信局域网或 Tailscale；不要把网关端口直接暴露给不受信任的网络。
