# Markdown 卡死类回归覆盖

更新于 2026-10-24，承接 issue #22 的紧急修复。这里记录自动化覆盖与可复跑入口，不表示任意输入或真机环境都已穷尽。

## 日常门禁

`npm run check` 自动包含以下测试；没有新增依赖，也不需要可选环境变量。只运行相关检查时可用：

```sh
node --test tests/md.test.js tests/md-robustness.test.js tests/md-images.test.js tests/genui.test.js tests/history-ui.test.js
```

本轮专项 63/63 通过，无跳过；全量 985 项：966 通过、19 跳过、0 失败。全量使用允许 Windows 进程身份查询的测试环境，既有平台／可选跳过未改。日志在 `dist/issue22-extra-tests-2026-10-24/`。

## 覆盖什么

| 场景 | 检查 |
| --- | --- |
| CRLF／CR／混合换行 | 标题、引用、列表、表格、代码块与 LF 输出一致；末尾单独 CR 正常结束 |
| 标记边界 | 1,008 组标题／引用／列表标记、普通空格／Tab／NBSP／控制空白／Unicode 行分隔符、缩进和换行组合；文本不丢失，后续标题仍可渲染 |
| 混合文档 | 固定种子 `0x22c0ffee` 生成 256 份文档，包含畸形标记、代码围栏、富内容、链接和原始 HTML；换行变换后输出一致，脚本保持转义 |
| 流式输出 | 对 5 份含围栏、链接、列表、表格和异常行分隔符的文本逐字符截断，共 312 个前缀；中间状态可以返回，危险脚本不成为 HTML 元素 |
| 深度与长度 | 96 层列表保留叶子和后续标题；1,000 行兜底文本和长标点输入正常完成，尾部内容可见 |
| 加载方式 | 根目录 CommonJS、浏览器全局导出和插件浏览器副本对相同输入及 richContent／fileLinks／imageHosts 设置输出一致 |
| 缓存与历史窗口 | 实际 `history.js` 缓存存取 API 与 HistoryView，在内存 localStorage 和 DOM fixture 中恢复 420 条记录；异常消息分布在窗口边界，向上翻页直至最老记录、回到底部及再次打开均无渲染错误；原始 CRLF 文本不被改写 |

新测试位于 `tests/md-robustness.test.js` 和 `tests/history-ui.test.js`；原始 #22 回归继续保留在 `tests/md.test.js`。

## 防止测试自身挂住

`tests/fixtures/bounded-markdown.cjs` 在 VM 中加载实际渲染器，使用能中断同步 JavaScript 的执行超时。普通调用预算 1 秒，较长输入为 3 秒；这是死循环保护，不是精确性能指标。不能仅依赖 `node:test` 异步超时，因为它无法中断占住事件循环的同步循环。

测试还故意运行一个永不前进的假渲染器，验证保护确实抛出 `ERR_SCRIPT_EXECUTION_TIMEOUT`。此次额外在内存中分别移除真实源码的换行归一化、段落前进兜底，再执行新增测试：前者被 3 组用例检出，后者被 5 组检出；没有写入或替换生产文件。复跑脚本及结果为证据目录的 `mutation-probe.cjs`、`mutation-results.json`。

## 后续维护

新的解析卡死报告应先缩减成可复现输入，加入有同步超时保护的回归，再修改解析器。固定种子失败时断言会保留样本编号与完整输入，可作为后续的独立回归样本。格式正确性、内容保留和安全转义仍需断言，不能仅以“函数返回了”判为通过。

本轮只增加／整理测试及文档，没有再改产品代码，上一轮热修 APK／tgz／buildId 保持不变。自动化缓存检查使用测试存储和 DOM fixture；原报告者 Android 缓存会话、真实 WebView 与真机覆盖升级仍需单独验收。
