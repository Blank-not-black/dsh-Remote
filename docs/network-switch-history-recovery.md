# 切换网络后会话空白、拉取不结束及无法返回

2026-10-20。在已有未提交工作区中修复移动 WebUI / Android WebView 的恢复链路，并同步桌面 WebUI 的同类读取问题。未改线上配置，未部署、安装、提交或发布。

## 定位结果

1. **自动换线留下无效会话页**：回前台测速选择不同 URL / token 时，连接身份 setter 清空 `current` 和历史，并清除历史 DOM，但没有退出会话视图。旧历史响应因连接身份失效被丢弃；手机端返回按钮又因 `current` 为空直接返回。这条路径能同时解释空白及返回无效。修复后，失效会话自动回到会话列表，返回操作也允许空会话 ID。
2. **旧网络读取阻挡补同步**：回前台、online 和网络类型变化原先没有取消正在进行的历史读取。`history.loading` 会阻止后续读取，弱网等待可达 90 秒；不支持 `AbortSignal.timeout` 的 WebView 还缺少超时兜底。现在恢复连接会取消旧历史读取、重新建立实时通道并安排补同步。读取覆盖响应体的完整期限，取消后即使底层请求不响应，也会释放等待；迟到的结果不能覆盖新请求或清除新请求的 loading。
3. **本地缓存读取可能无限等待**：IndexedDB 打开有超时，但 `get()` 事务没有等待上限；打开会话又先等待缓存，因此可以一直停在“正在拉取”，尚未发出历史 RPC。现在缓存读取最多等待 1.5 秒，失败或事务中止后使用后备缓存 / 服务端读取。晚到缓存不能覆盖权威响应，远程读取期间恢复的缓存也会在网络失败时保留。

这些结论来自源码与隔离回归测试。没有手机日志，不能宣称已经确认用户手机每次复现都由同一条路径触发。

## 本次改动文件

- `public/app.js`：身份切换后的导航、无 ID 返回兜底、历史请求取消和请求归属校验、回前台 / online / 网络类型变化恢复，以及原有 Capacitor App 插件的 appStateChange 恢复入口。
- `public/desktop/desktop.js`：对应的导航与读取恢复。
- `public/network.js`：可取消且包含完整响应体期限的只读请求封装；不自动重试发送操作。
- `public/history.js`：IndexedDB 读取期限、事务错误和中止处理。
- `tests/back-navigation-recovery.test.js`、`tests/connection-isolation.test.js`、`tests/history-load-recovery.test.js`、`tests/history-ui.test.js`、`tests/network-policy.test.js`、`tests/session-list-ui.test.js`：回归场景及现有隔离 fixture 适配。
- `public/build.json` 及 `packages/plugin/public/` 中上述四个 JS 和 build.json 的同步副本：由现有构建 / sync-plugin 脚本生成。插件其他已有同步资源和工作区改动保留。
- 本文档。

没有新增依赖，没有直接手工编辑插件内的 app.js 副本。APK 构建时的版本元数据临时变更已恢复，保留现有分发 APK 与更新元数据的关系。

## 验证

- 最终 `npm run check`：**804 项，790 通过，14 跳过，0 失败**；日志 `dist/network-switch-check-final.log`。
- 专项五个测试文件：**87 项全部通过**；日志 `dist/network-switch-targeted.log`。包括无会话 ID 返回、自动换线、旧请求取消与迟到响应、读取超时、准备阶段异常、缓存等待与远程读取竞态。
- `npm run sync-plugin`、四个修复 JS 的源 / 插件副本一致性及 `git diff --check` 通过。
- 初次全量运行中两项 Windows supervisor 测试因沙箱无法查询进程身份而失败，使用宿主权限重新检查后通过，未放宽进程身份保护。
- 最后一次全量复核前，共享工作区的其他插件面板改动短暂造成三个相关用例失败；它们更新后单独复跑和最终全量检查均通过。本次没有修改这些插件面板实现或测试。
- 两个公网入口 `remote.blankalwaysgoeson.site` 和 `relay-self.blankalwaysgoeson.site` 的 `/health?probe=live` 均为 HTTP 200，rc.6，upstreamOk / mux / host 均正常。这只能证明检查当时服务端健康，不能证明手机网络路径正常。
- ADB 已检查，没有连接的设备。因此没有本轮真实 Wi-Fi / 蜂窝切换、VPN 对照或手机 UI 验收证据。

## 本地 APK

- 路径：`dist/network-switch-2026-10-20/dsh-remote-0.8.0-rc.6-network-fix.apk`。
- 10,628,829 字节，SHA-256：`206adf5f8298e03a71c1e223a819ae869e2eb4b9afa561a86b69c3408bbc9621`。
- 包名 `com.dshremote.app`，versionName `0.8.0.rc.6`，versionCode `8006`；APK v2 签名验证通过。
- APK 构建快照 buildId：`f4cf65663d01d70d2b5132d5c30e54643e0607aa62152dd216ab137bdd0a74d3`，副本保存在产物目录的 build.json。共享工作区后续其他文件变动可能生成新的 buildId。
- 已逐字节核对 APK 内 app.js、desktop/desktop.js、network.js、history.js 与本次修复源码。构建日志：`dist/network-switch-build.log`。
- 这是同一 rc.6 下的本地复测包，未覆盖正在分发的 APK，也未替手机安装。`npm run publish` / release 均未执行。

真机待验收：进入有历史的会话后将 App 切到后台，切换 Wi-Fi / 蜂窝网络再回前台；分别覆盖同一入口恢复和自动选择另一入口、恢复前服务器不可达、拉取中返回及立即重进。预期能恢复历史或显示可重试状态，返回始终可用；自动换到其他连接身份时返回列表，避免把旧连接的会话直接套用到新连接。
