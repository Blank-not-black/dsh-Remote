# dsh-remote-plugin

DSH Remote 的 DSH bundle 插件：在 DSH 左侧原生边栏注册入口，点击从右侧滑出管理抽屉；插件**内置网关程序并随 DSH 自动启停**（独立 systemd 单元），抽屉直显令牌、主机 IP 与设备监控，配合 [dsh-Remote](https://github.com/Blank-not-black/dsh-Remote) 的 Android App 实现手机远程操控。

## 安装

```sh
dsh plugin --profile web add dsh-remote-plugin
# 或 pin 版本
dsh plugin --profile web add dsh-remote-plugin@0.4.4
```

重启 DSH Web 后 Ctrl+F5，左侧边栏底部出现 App 图标入口。

git 源安装（等价）：

```sh
dsh plugin --profile web add "github:Blank-not-black/dsh-Remote#main&path:/packages/plugin"
```

## 网关

- 默认**自动启动**：DSH 启动或抽屉刷新时，插件会拉起内置 `gateway.cjs`（`0.0.0.0:8787`），独立于 DSH 进程。
- 开关持久化在 `~/.dsh-remote/gateway.enabled`；抽屉内可停止/启动。
- 令牌在 `~/.dsh-remote/token`（首次自动生成，重复使用不覆盖），抽屉里显示并可复制。
- 环境变量 `DSH_REMOTE_AUTOSTART=0` 可关闭自动管理。

## 手机 App

从 [Releases](https://github.com/Blank-not-black/dsh-Remote/releases/latest) 下载 `dsh-remote.apk`，设置服务器 `http://电脑IP:8787` + 抽屉里的令牌即可。

## License

MIT
