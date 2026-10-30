# 0.1.7：浏览器上传、精简回执与 Windows 调用复用

本次按实际代码与宿主协议核验方案，保留可验证的收益。字符数不等于模型 token；文件路径直传也不代表浏览器没有磁盘、内存或网络开销。

## 方案逐项决定

| 方案 | 决定与实现 |
| --- | --- |
| 改写历史 User 消息、替换旧快照 | 不采用。DSH `agent/pre-step` 传入本步认领的增量消息批次，并非整段历史。现有 `prepared` 缓存避免同一消息重复读取；用户原文和历史保留。没有证据支持“节省 60%～80% token”。 |
| 轻量 snapshot 句柄 | 采用 `observe: "handle"`。内部生成完整新快照，返回 ID、游标与少量元数据，不返回正文；节省回执字符，不省去本次 DOM 遍历。新句柄不会授权旧元素编号：只能用选择器继续，或先读返回的游标再使用 refs。 |
| 自动剪到 main / article / #root | 改为显式 `scope: "main"`，仅选唯一可见的 `main` 或 `[role=main]`，否则读取 body。默认保留导航、侧栏和对话框；不按框架容器 ID 猜主内容，也不删除页尾或任意 generic 节点。 |
| 批注仅留四个样式 | 部分采用。尺寸已在 rect 中，删除重复 width/height，并省略默认间距和层叠值；保留颜色、字体与有效布局属性，供设计修改使用。 |
| 每次 PowerShell 编译 C# | 用按需启动的持久 PowerShell worker 替代反复启动/编译。每个 worker 生命周期只加载一次 Win32 类型，库存与窗口恢复共用；串行执行，取消或超时结束该 worker，不自动重放，空闲 30 秒退出。卸载插件也会关闭 worker。未新增原生 DLL/Rust 构建链。 |
| `type_text` 一律改 `set_value` | 不采用。固定 Cua Driver 0.28.0 的 `type_text` 在提供元素索引时已走 UIA `ValuePattern.SetValue` 并读回确认；并非总是逐字符输入。保留当前 `app_type mode:value` 与驱动校验，按键目标继续走按键路径。 |
| 放宽 SPA 路由中断 | 有条件采用。同文档、同 origin/path 的 query/hash 变化后，仅允许无旧 ref 的选择器观察（wait/extract）及滚动/显式导航继续。后续点击、填写、上传等输入仍停止并要求重新读取；选择器本身不能证明新表单与旧表单语义相同。 |
| 单活动标签页自动授权 | 不采用。活动页面不等于用户授权；仍需在会话中用 `@` 选择一次。一个已授权且在线的页面可继续省略 tab 参数。 |
| 操作光环与 HUD 停止 | 采用。输入期间显示“DSH 正在操作此页面”和停止按钮，对可定位目标显示短暂光环。HUD 位于独立 CDP world 的 closed shadow root；页面脚本不能调用停止绑定。停止会取消当前调用并阻止后续步骤，不承诺撤销已发送输入。 |
| 物理输入自动抢占 | 不采用。CDP 输入也可能产生 `isTrusted` 事件，无法据此可靠区分人工与自动化；不增加会误停自身的监听器。HUD 的 `isTrusted` 仅拒绝脚本伪造按钮点击。 |
| 路径直传 browser_upload | 采用独立工具和 batch `op: "upload"`，支持隐藏 input、自定义 file chooser 与跨域 iframe。要求已选标签页及用户在本会话明确给出的完整绝对路径；校验可读普通文件。 |
| 自动追加 CEF 参数或重启 | 不采用。不同程序对参数和无障碍支持不同，自动重启会打断工作。当前先读 UIA，空树时按需截图、用已有 `app_mouse` / `app_type`；若用户明确要求以辅助参数启动某个程序，再按该程序文档操作。 |
| 快捷键优先 | 复用 `app_type keys` / `app_desktop hotkey`，不增加猜测意图的全局快捷键注册器。仅对已选应用和用户明确的保存/撤销等意图发送快捷键，并遵循驱动的后台投递/前台审批契约。 |
| Office COM 通用绿色通道 | 本轮不增加。没有具体工作簿、文档或数据操作需求，通用 COM 读写桥会扩大权限和维护范围。现有 MCP/CLI 优先发现保留；明确文档任务可选择对应专用接口。 |

## 上传用法与授权

用户先用 `@` 选择目标标签页，并在消息中给出要上传的完整本地路径，例如“把 `C:\Reports\report.pdf` 上传到这个表单”。选择页面并不授权读取其他本地文件；网站中的路径和提示也不算授权。路径授权保存在当前插件进程的会话缓存中，重启后需再次提供；不会记录文件内容。

读一次页面后调用：

```json
{
  "snapshot": "<browser_read 返回的 ID>",
  "selector": "input[type=file]",
  "files": ["C:\\Reports\\report.pdf"],
  "observe": "handle"
}
```

`selector` 也可指向打开文件选择器的按钮。跨域 iframe 内的控件可传 `frame: "iframe#uploader"` 加框内 selector，或使用页面快照提供的 `fNeN` 引用。支持一个 iframe 定位层级；更深的页面需按实际定位能力处理，不猜文件控件。

`browser_act` 的步骤也支持 `op: "upload"`、`files`、`frame`。一批里的所有文件在任何步骤执行前校验，避免填完前半张表单才发现路径不合法。上传可能在选择文件后立即开始，需要用户已授权向该网站披露文件。结果只带文件名，不传文件字节。

本地 extension/CDP 连接设置 Playwright 1.64 的 `isLocal: true`，使 `setInputFiles` 发出 `DOM.setFileInputFiles` 路径命令。默认远程 CDP 模式会转换成文件 payload，因此不能仅凭调用 `setInputFiles` 就宣称路径直传。没有绕过网站或浏览器的文件大小限制，也没有声称 GB 文件“零内存瞬时上传”。

## 回执选择

- 默认 `snapshot`：返回新快照及有限正文，适合继续使用新 refs。
- `summary`：不生成新快照，适合任务已经结束；下一次操作先重新读。
- `handle`：生成新快照但不返回正文，返回 `snapshot`、`cursor`、`refs: "read_required"`。已知选择器可继续；需要元素编号时，先 `browser_read {cursor: "<返回的 cursor>"}`，使用实际读到的新 refs。旧 snapshot ID 与未读的旧 refs 均被拒绝。

停止/取消后返回已完成步骤与可能存在的迟发副作用。先检查当前状态，不自动重复上传、点击或提交。

## 验证与测量

本地真实 Chromium 经配对扩展/CDP 测试了隐藏 input、自定义 chooser、跨域 iframe、上传/填入/提交批处理、handle 读取契约、SPA 观察与 HUD 点击停止。抓取的三次上传命令均为 `DOM.setFileInputFiles`，只携带本地路径，测试文件仅挂载到本机测试页，没有向第三方网站上传。

Windows 同机窗口枚举对照：每次新 PowerShell 的三次耗时为 769 / 727 / 822 ms；持久 worker 首次为 2768 ms，后续五次为 295 / 316 / 338 / 327 / 327 ms。此次暖调用中位数从 769 ms 降到 327 ms，约减少 57%；冷启动反而更慢。这个小样本包含进程元数据查询，不是纯 Win32 API 时延，不代表其他机器，也不构成 5 ms 承诺。

单元测试覆盖路径授权、上传前校验、句柄/旧引用拒绝、SPA 输入中断和 Windows worker 取消后重启；安装版 DSH 的 Typert、Gateway、原生引用和批注草稿契约也已验证。核验脚本兼容 `client.browser.js` 命名，并按 ASAR 完整头长度定位文件内容。

实现依据：固定版本的 [Cua Driver Windows 工具文档](https://github.com/trycua/cua/blob/cua-driver-rs-v0.28.0/docs/content/docs/reference/cua-driver/mcp-tools-windows.mdx)、本项目固定 Playwright 1.64 的 `ConnectOverCDPOptions.isLocal` 类型与上传实现，以及当前安装 DSH 的实际运行包。

## English

0.1.7 adds `browser_upload` and batch uploads with exact user-supplied absolute paths, a selected tab, regular-file validation, hidden input/custom chooser support, and iframe selectors. Local CDP uses Playwright's `isLocal: true`; real integration checks assert `DOM.setFileInputFiles` paths instead of base64 payloads. Selecting files can immediately disclose/upload them to the website.

`observe: "handle"` returns a fresh snapshot ID and cursor without page text. Continue with known selectors, or read the returned cursor before using element refs; old refs cannot silently bind to a new snapshot. `scope: "main"` explicitly narrows DOM reads to a unique visible main landmark. Query/hash routing only continues selector observations or target-free steps, never further form input on an assumed unchanged page.

Browser input displays private stop controls and a brief target highlight. Stop aborts the active call and later batch steps; dispatched effects may still complete. A persistent Windows helper reuses Win32 types for inventory/focus and exits on cancellation, plugin unload or 30 seconds idle. Warm inventory improved in the local sample above, with a slower cold start; no universal latency or token reduction is claimed.

Existing incremental pre-step batching, atomic UIA typing with `type_text`, explicit tab selection and app hotkeys are retained. Unreliable physical-input inference, automatic CEF restarts and an unrestricted Office COM bridge are not introduced.
