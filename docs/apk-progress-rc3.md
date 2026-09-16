# 0.6.25-rc.3：功能测试清理与 APK 下载进度

功能测试页保留入口、标题和返回按钮，内容留空。移除 ASR 页面、前端事件处理、专用 Android 桥及其麦克风权限和语音服务查询声明。

APK 更新增加进度条、百分比、已下载/总大小及实时速度。未知总大小时显示不定进度；停顿时速度归零；下载、校验、完成、错误状态独立显示。防止连续点击重复启动下载，失败后可重试。

新版 Android 壳通过原生桥回传进度，下载过程中计算 SHA-256，同一份文件校验通过后交给安装器，避免原先前端校验下载一次、原生安装再下载一次。浏览器同样复用已经下载并校验的 Blob。旧 Android 壳兼容路径只能显示前端下载进度，原生安装阶段仍沿用旧实现；安装 RC.3 后才能完整使用新流程。

改动文件：`public/app.js`、`public/index.html`、`public/styles.css`、`android/app/src/main/java/com/dshremote/app/MainActivity.java`、`android/app/src/main/AndroidManifest.xml`、`tests/asr-test-ui.test.js`、`tests/apk-progress.test.js`，以及版本元数据和脚本生成的插件副本/APK。

验证：完整检查 174 项，170 通过、4 项平台相关跳过；Android 构建成功。专项覆盖百分比/速度、未知长度、停顿、重复点击、单次前端下载、损坏/截断拒绝，以及原生桥路径不进行前端预下载。手机宽度浏览器已实际确认功能测试页只剩标题和返回按钮。Android 真机安装与系统安装器交互尚未验证。

本机插件已升级并重启至 RC.3，健康状态 ready。实际 HTTP 下载 APK 的 SHA-256 与更新清单和本地产物一致：`5abb07301b4e90b2ba1c0c292c9c951a2449825f5003b02c3aac5509a891b810`。产物在 `dist/rc-0.6.25-rc.3/`，常用 APK 路径仍为 `apk/dsh-remote.apk`。

本轮及此前源码改动均未提交，未向外部发布。
