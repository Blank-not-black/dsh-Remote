# HarmonyOS 自构建与签名

[文档首页](README.md) · [工程说明](../harmonyos/README.md) · [客户端模块](modules/11-harmonyos-app.md)

## 工程与产物边界

仓库提供 ArkTS/ArkUI 工程 `harmonyos/`，bundle 为 `com.dshremote.app`。截至本轮源码核对（2026-10-12），manifest 为 `versionName:0.6.26`、`versionCode:6269`，目标 SDK `26.0.0`、兼容 SDK `6.1.1(24)`。这些是配置值，不是本轮构建或设备兼容性实测结果。

根 `npm run release` 与当前 GitHub release workflow 不构建 HAP，也不更新鸿蒙 manifest。不能把根项目 `0.7.4` 当作 HAP 版本，不能把 APK 当成鸿蒙安装包。当前没有仓库级 `build-harmonyos-local.ps1` 或 HAP 校验脚本，历史环境中的个人脚本不作为克隆后的可用命令。

## 准备环境

1. 安装支持工程目标 SDK 的 DevEco Studio 与官方 SDK/Node/Hvigor 工具链。
2. 打开 `harmonyos/`，按 IDE 提示同步已有工程依赖；不添加第三方运行时包。
3. 阅读[目录守则](../harmonyos/AGENTS.md)。`build.cmd`、`local.properties` 和签名材料属于本机配置。
4. 如使用 CLI，在 `local.properties` 写入本机 SDK 路径，文件保持被忽略。不要复制旧报告中的个人机器路径。

`oh-package.json5` 的运行时 `dependencies` 应保持为空；官方测试 devDependencies 按现有工程保留。SDK/设备版本以实际安装与 ROM 为准，旧设计调研不保证新 API 可用。

## 构建未签名 HAP

优先在 DevEco Studio 使用工程构建入口。Windows CMD 可按本机路径运行下面的工具链命令（`<...>` 为需替换的占位符）：

```bat
set "DEVECO=<DevEco Studio 安装目录>"
set "PATH=%DEVECO%\jbr\bin;%DEVECO%\tools\node;%PATH%"
set "DEVECO_SDK_HOME=%DEVECO%\sdk"
cd /d "<仓库根目录>\harmonyos"
"%DEVECO%\tools\hvigor\bin\hvigorw.bat" assembleHap --mode module -p module=entry@default -p product=default
```

本机 `local.properties` 的 `sdk.dir` 与实际工具链匹配。预期输出目录为 `entry/build/default/outputs/default/`，无签名配置时常见产物 `entry-default-unsigned.hap`。以本次构建实际文件为准。

增删媒体资源后先确认工程内绝对路径，再清理 `entry/build/default/intermediates` 并重建，避免增量资源索引与代码资源 ID 不一致。不要递归删除工程外路径。

## 签名与安装

未签名 HAP 不能直接当作可安装包。推荐在 DevEco Studio 登录自己的开发者账号，在 Project Structure → Signing Configs 使用自动签名，连接目标设备后 Run 或构建已签名 HAP。

本地生成的证书、profile、`.p12/.p7b`、口令和设备材料不要入库。仓库 `build-profile.json5` 保持 `signingConfigs:[]` 且 product 不引用私人签名配置；不要把含签名信息的整个文件提交到 release 的 `git add -A`。

若使用 hdc（实际签名包路径替换占位符）：

```sh
hdc list targets
hdc install -r <已签名HAP路径>
hdc shell aa start -a EntryAbility -b com.dshremote.app
```

安装成功后再验证实际应用版本、配对和功能。侧载签名的设备授权/有效期由自己的证书与 profile 决定。

## 真机验收

- 手机与平板布局、宽屏断点、分组展开、系统返回链路。
- 配对多地址、切换服务器/令牌、连接恢复、迟到响应隔离。
- 历史/实时消息、思考基线、图片附件、目标、停止生成与长按插队。
- 文件多根、中文/大文件分块、续传、SHA-256 与系统另存为。
- 插件中心的当前主机归属、确认/重试及配置生效提示。
- 通知授权、后台长时任务、峰谷提醒代理被拒后的回退。
- 系统深浅切换、ASR 麦克风授权与释放、侧载后台限制。

编译成功只能证明该工具链接受工程；历史真机记录只适用于当时版本。本轮文档更新没有构建或安装 HAP。
