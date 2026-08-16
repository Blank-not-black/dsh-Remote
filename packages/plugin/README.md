# dsh-remote-plugin

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

**中文** · [English](README.en.md)

DSH Remote 的 DSH bundle 插件：在 DSH 左侧原生边栏注册入口，点击从右侧滑出管理抽屉；插件**内置网关程序并随 DSH 自动启停**（独立 systemd 单元），抽屉直显令牌、主机 IP 与设备监控，配合 [dsh-Remote](https://github.com/Blank-not-black/dsh-Remote) 的 Android App 实现手机远程操控与文件互传（`/fs/list`、`/fs/file`、`/fs/upload`）。面板内置四套皮肤（深空 / 落日 / 易北爱乐厅 / 草原孤塔），亮暗中性三档随系统偏好自动切换。

## 安装

```sh
dsh plugin --profile web add dsh-remote-plugin
# 或 pin 版本
dsh plugin --profile web add dsh-remote-plugin@0.5.0
```

重启 DSH Web 后 Ctrl+F5，左侧边栏底部出现 App 图标入口。

git 源安装（等价）：

```sh
dsh plugin --profile web add "github:Blank-not-black/dsh-Remote#main&path:/packages/plugin"
```

## 网关

- 默认**自动启动**：DSH 启动或抽屉刷新时，插件会拉起内置 `gateway.cjs`（`0.0.0.0:8787`），独立于 DSH 进程；Linux 使用独立 systemd 单元，macOS 等无 systemd 环境自动回退为常驻子进程。
- 开关持久化在 `~/.dsh-remote/gateway.enabled`；抽屉内可停止/启动。
- 令牌在 `~/.dsh-remote/token`（首次自动生成，重复使用不覆盖），抽屉里显示并可复制；支持**二维码扫码配对**与**一键轮换**。
- 环境变量 `DSH_REMOTE_AUTOSTART=0` 可关闭自动管理。
- 文件端点：`/fs/list`（列目录）、`/fs/file`（下载，支持 Range）、`/fs/upload`（分块续传，支持暂停/取消，落盘前 SHA-256 校验）；默认根目录 `~`，`DSH_REMOTE_FS_ROOT` 可开多根（`:` 分隔）。

## 手机 App

App 已随插件包内嵌（`apk/dsh-remote.apk`），装好插件即可获取，无需上 GitHub：

- 桌面抽屉点「二维码」→ 手机扫码打开管理页 → 页面提供 App 下载
- 或浏览器直接访问 `http://<网关IP>:8787` 下载
- App 更新同样走网关自动推送（`update.json` 相对路径），全程不绕 GitHub

App 内置多服务器测速切换与聊天记录离线缓存，下载文件统一放系统「下载/dsh-remote」。

## License

MIT
