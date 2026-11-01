# 浏览器工作流与诊断

## 引用与批注

点 DSH 左导航的“浏览器”，在当前会话右侧查看“网页”“应用”和“打开日志”。点击网页或应用会追加到当前输入草稿，保留已有文字、引用和附件；`@` 菜单仍可使用。写好任务后由你发送。没有打开会话时，可以查看列表和连接设置。

网页、应用、页面批注和主动引用的诊断日志在消息里显示为可展开引用。收纳只影响显示，发送给模型的原始内容不变。

批注浮窗的“收起”隐藏编辑区；“收纳”将整个浮窗移到页面边缘，并停止选择元素，让网页恢复正常鼠标与键盘操作。点边缘“批注”按钮恢复原位置、说明和截图选项。重新选择元素不会清空说明。“关闭”则清除未完成批注。

README 的浏览器面板图由当前组件使用已安装 DSH 的 React/UI 图元及示例数据渲染；它不是完整 DSH 宿主截图。批注图来自真实组件与本地测试页；连接页图来自真实页面与示例配对请求。

## 本地诊断

“打开日志”记录 `host_send → extension_receive → api_settle → extension_response → host_response` 阶段，包含关联编号、方法、时间、耗时、版本和归类错误码。最多保存 600 条，仅在本机内存保留；可停用、清空或导出。不记录命令参数、页面正文、URL、token、Cookie 或原始错误信息。重启插件后清空。

日志不会自动加入聊天。“引用到草稿”才会追加日志引用，发送后日志将进入你配置的模型上下文。阶段耗时为从主机投递到收到该阶段标记的累计时间，不应将它们相加解释为网络延迟。

## 拖拽、文件投放与网络请求

`browser_act` 在新鲜快照上支持：

```json
{"op":"drag","selector":"#card","toSelector":"#column"}
{"op":"drop","selector":"#upload-zone","files":["E:\\Work\\image.png"]}
{"op":"drop","selector":"#drop-zone","data":{"text/plain":"example"}}
```

`drag` 的源与目标必须在同一 frame，可使用 `ref/toRef` 或 `selector/toSelector`；iframe 用同一个 `frame` 指定。文件投放与上传同样要求用户在会话中明确提供绝对路径，选择页面不代表授权披露本地文件。失败或不确定结果不应自动重放。

`browser_network_requests` 必须先传 `action: "start"`，只记录之后的请求，不恢复历史、不自动刷新页面。省略 action 或传 `list` 返回默认 10 条、最多 20 条；用 `query`、`errorsOnly`、`includeStatic` 筛选，使用返回的 `nextAfterId` 作为下一页 `afterId`。默认略过成功的静态资源。`details` 加 `requestId` 查看单条时序和 MIME 类型；`clear` 清空，`stop` 移除监听器。

最多保留 200 条，超过后淘汰旧记录；空闲释放调试连接时清空。返回 `capturingSince`，明确起始时间。仅记录 HTTP(S) 请求方法、去掉查询/片段/凭据的 URL、资源类型、状态码和时序，不记录请求头、响应头或正文。URL 路径本身仍可能包含站点业务标识。

<a id="english"></a>

## English

Open **Browser** in DSH's left navigation to show the current session's right panel. **Pages**, **Apps** and **Open logs** share the panel. Selecting a page or app appends a reference to the current draft, preserving text, references and attachments. The `@` menu remains available; the human sends the draft. Without an open conversation, the panel can still list objects and open setup.

Page/app context, annotations and explicitly referenced logs display as expandable chips. This changes presentation only; the original serialized model context remains intact.

The annotation toolbar's **Collapse** hides its editor. **Dock** leaves an edge button, preserves the draft and position, and stops element picking so the page receives normal mouse and keyboard input. Restore from the edge button; selecting another element retains the comment. **Close** clears the unfinished annotation.

The README panel preview renders the current component with the installed DSH React/UI primitives and sample data; it is not a full DSH host screenshot. The annotation preview uses the real component on a local fixture; the setup preview uses the real page with a sample pairing request.

Diagnostics keep up to 600 in-memory metadata events: correlated command stages, method, timestamp, elapsed time, version and categorized error code. They retain no command arguments, URLs, page text, tokens, cookies or raw errors. Disable, clear or export them from **Open logs**; restarting the plugin clears them. Logs enter a draft only when explicitly referenced, and enter model context only when that draft is sent. Stage timings are cumulative from host dispatch to receipt of each marker; adding them does not measure network latency.

`browser_act` supports the `drag` and `drop` examples above on a fresh snapshot. Drag source and destination share a frame; use `ref/toRef` or `selector/toSelector`, with `frame` for iframes. File drops require exact absolute paths explicitly supplied by the user in the conversation, just like uploads. Never replay failed or uncertain effects automatically.

Use `browser_network_requests` with `action: "start"` before the activity. Capture cannot recover past traffic and never reloads/replays requests. `list` (the default) returns 10 entries, up to 20, with `query`, `errorsOnly`, `includeStatic` and `afterId` filters. Use the returned `nextAfterId` for pagination. Successful static resources are hidden by default. `details` plus `requestId` returns timing/MIME metadata; `clear` removes entries and `stop` removes listeners.

Capture retains up to 200 entries, evicts older entries and clears on idle debugger detach. `capturingSince` states the start time. Only HTTP(S) methods, redacted URLs, resource types, statuses and timing are recorded. URL queries, fragments, credentials, headers and bodies are excluded; URL paths may still contain site-specific identifiers.
