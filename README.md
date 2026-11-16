# BPS for Magpie

当前版本：0.4.4。自动同步模型及思考强度，默认处理兼容性，并提供工具格式纠错和推理流保护。

独立 Magpie / OpenCode provider：Excel/BPS OAuth 授权、令牌刷新、Responses
推理、流式文本与工具往返，以及 ChatGPT/Codex 额度查询和手动重置。

插件独立运行，无需额外网关服务。

## 安装

在 [GitHub Releases](https://github.com/pdxxxx/bps-magpie/releases) 下载
`bps-magpie-0.4.4-win32-x64.zip`，解压到任意固定目录。在 Magpie → Plugins →
Add a plugin 中填写解压后的 `bps-magpie` 目录。Windows x64 发布包已包含转换程序，
不需要安装 Node.js 或 Go。也可执行（将路径替换为实际解压目录）：

~~~powershell
& "$env:LOCALAPPDATA\Programs\magpie\magpie.exe" plugin add D:\Workspace\bps-magpie
& "$env:LOCALAPPDATA\Programs\magpie\magpie.exe" plugin login bps
~~~

在浏览器完成 ChatGPT Excel/BPS 授权后，复制地址栏的完整回调 URL 到 Magpie。
必须包含 code 和 state，不要只贴授权码。回调页即使报错，也可以复制带这些
参数的地址。登录后即可选择自动同步的可用模型。

这是独立 Excel OAuth grant，不能用修改 client ID 的方式转换 Codex token。
授权校验 PKCE、回调地址、state、有效期、唯一 code，以及 token 的 client 和
workspace 一致性。凭据由 Magpie 保存；转换子进程不接收 token。

真实登录完成后，可主动发送一条最小推理验证实际权限（会产生实际用量）：

~~~powershell
& "$env:LOCALAPPDATA\Programs\magpie\magpie.exe" provider test bps <实际可用的模型ID>
~~~

## 额度、次数与重置

Magpie 的账号额度卡片会读取：

- ChatGPT/Codex 主窗口、次窗口和附加窗口的已用百分比及重置时间。
- Codex 点数余额，保留上游十进制字符串精度。
- 可用重置次数、最近到期时间，以及每次重置额度的到期明细。

这些来自 ChatGPT/Codex 的 wham 接口，明确标成 Codex 额度，并作为展示数据。
没有假定 Codex 窗口耗尽必然阻止 BPS 推理。查询失败或字段缺失不会伪装成 0。
额度接口的权限错误也不会直接使仍有效的 BPS 登录失效。

手动管理入口是插件自带的八个工具，Magpie 会通过插件工具 MCP
（/mcp/magpie/tools）提供给 agent。实际名称会带宿主添加的插件前缀：

| 工具 | 用途 |
| --- | --- |
| bps_diagnostics | 本地检查构建版本、协议、代理模式、缓存与凭据新鲜度，不访问上游 |
| bps_accounts | 列出本插件账号标识，不返回 token |
| bps_quota | 查询指定账号的额度、点数和重置次数 |
| bps_prepare_reset | 查询剩余次数并生成绑定账号的兑换请求，不消费 |
| bps_reset | 使用准备好的 request_id 执行一次重置，要求 confirm=true |
| bps_reset_status | 分页或按请求 ID 查询本地重置回执，token 过期时也可查看 |
| bps_retry_reset | 首次发送十分钟内，明确要求重试时复用原兑换 ID |
| bps_resolve_reset | 核实实际结果后登记 consumed / not_consumed 的人工确认，不调用上游 |

使用顺序为 bps_accounts → bps_quota；需要重置时执行
bps_prepare_reset → bps_reset。仅在你明确要求重置时执行消费步骤。

bps_reset_status 默认返回最近 100 条回执。可传 offset / limit 分页（limit 为
1–100），结果提供 total、hasMore 和 nextOffset；也可只传 account 与 request_id
直接查询旧回执。request_id 不能与分页参数一起使用。查询仅访问本地回执，
已保存 token 过期时仍可使用；不会触发重置或消耗次数。

每个准备请求十分钟内有效，实际执行时消耗一次 Codex 重置次数。
重复准备复用同一请求；同一 workspace 的不同账号别名共用消费锁。

兑换请求 ID 在发送前落盘，同一请求再次调用不会重复消费，插件重启后仍生效。
网络中断或结果不明会返回 unknown，不自动重试。成功消费但后续额度刷新失败
会明确返回“已重置，回读失败”，不会把成功消费误报成可重试失败。
存在 unknown 回执时，禁止另建兑换请求。可先用 bps_reset_status 查看，明确要求
重试时使用 bps_retry_reset 复用原 request_id。超过重试窗口时，必须核实真实账号
结果后再用 bps_resolve_reset 登记人工确认；不得根据用量百分比猜测是否已消费。
回执在发送前同步写入磁盘，人工确认与上游成功分别记录，不混淆验证来源。

管理工具只读取 Magpie 配置目录中属于 bps 的已登录账号，不写登录文件。
若 token 已过期或即将过期，先在 Magpie 刷新额度，让宿主统一续期，避免与
宿主的跨进程 refresh-token 锁竞争。继承代理模式下，额度卡片和推理在宿主的
账号代理作用域中执行，MCP 管理工具继承全局代理；指定插件代理时所有入口统一。

重置回执位于 Magpie 配置目录的 bps-resets/，不含 access/refresh token。
如果进程在消费时崩溃，残留账号锁不会自动清除；先查询额度和回执，确认没有
正在执行的重置，再处理对应 .lock 文件。不要以删除回执的方式重试不明消费。

## 模型与设置

登录后，Magpie 自动调用 BPS 的账号权限接口获取模型。刷新 Magpie 模型列表时会
重新同步；仅显示上游允许的模型和推理强度，禁用、受限或未配置的模型会被过滤。
未登录时不预填猜测模型。接口错误会明确报告，不生成默认模型清单。

「BPS 设置」只保留代理设置。超时和会话缓存位于默认收起的「高级选项」中，
不再提供模型输入，也不展示账号、额度和工具说明。账号登录在
「供应商 → 添加供应商 → 来自插件 → BPS」完成。

代理可选跟随 Magpie、指定 HTTP(S) 代理或直连；授权换票、模型同步、推理、
附件和额度请求共用同一代理策略。浏览器授权页面使用浏览器自身的网络设置。
SOCKS 代理请配置在 Magpie 中并选择跟随。连接失败不会自动回退直连。

保存后重新启用插件以应用配置。模型来自上游权限接口，旧 options.models 会被忽略，
下次保存设置时移除。没有写入推测的上下文长度、价格或账号权限。

## 默认兼容行为

以下两项始终生效，不需要配置，也不增加设置页开关：

- 保持 BPS，省略已知但不支持的托管工具声明，并向模型说明这些能力不可用。
  客户端函数与自定义工具保留；强制选择不支持的托管工具、或仅剩此类工具时
  要求 `tool_choice=required` 会明确报错。`tool_choice=none` 禁用工具，不切换通道。
- 历史消息、子代理消息和工具结果中的密文替换为固定的省略提示，保留明文、
  消息顺序和工具调用关系。正常推理、续接与压缩使用相同规则，缓存仅保存
  清理后的历史。推理记录及压缩窗口的 opaque state 保持原有处理方式。

当前任务或最新工具结果里的密文不会被静默丢弃，需要提供原始明文后重试。
省略声明不代表提供联网搜索、图片生成等托管能力；可用的客户端工具不受影响。

## 推理流保护

上游连续 120 秒没有实质数据时结束请求；空行和心跳注释不会延长等待。
持续到达的推理或文本数据会重置进展计时，本地消费者暂停不会消耗这段等待时间。
非流式请求返回明确的 504；流式请求已经开始后，返回 `response.failed` 终态。
连接中断、数据不完整和总超时同样明确报告，不自动重发已接受的推理请求。

工具调用只有格式错误、且整批尚未执行时，会请求 BPS 最多纠正两次格式。
纠错沿用同一账号、代理、模型和历史，保留原始操作内容；不允许替换已知工具目标，
不会重复输出正文或执行半截调用。纠错会产生额外推理用量，返回用量会合并统计。
未知工具、参数校验错误、网络失败、禁用工具及真实输出截断不会触发这类纠错。

`max_output_tokens` 表示上游未完成本轮输出。插件保留真实原因、推理用量和未完成状态，
不会将截断伪装成成功或缓存为可续接的完整响应。工具协议会提示模型分步生成大型文件，
每步只提交完整操作；这能降低单次输出过长的风险，但不能取消上游硬限制。
已用相同合法请求验证：BPS 接口不带 `max_output_tokens` 正常完成，添加该字段返回 422，
所以插件不会盲目转发客户端的输出上限参数。

## 会话续接与工具目录

当请求带稳定的 thread-id、x-bps-session 或 session_id 请求头时，可以用
previous_response_id 续接该插件进程中已完成的响应。Magpie 的 chat.headers hook
通常会补上会话头；直接调用插件 fetch 的客户端需要自行提供。thread-id 优先于
父会话标识，缓存按账号身份、workspace、线程和模型隔离，不能跨账号或模型取回。

续聊请求在本地展开为完整历史后发送给 BPS。前一轮顶层 instructions 不自动
继承；需要时应在新请求中再次声明。工具目录可在同线程后续请求中省略，
additional_tools / tool_search_output 输入项支持增量合并。显式 tools: [] 清空目录；
tool_choice: none 只禁用本轮，不清空保存的目录。历史目录控制项不会在续聊中
反复重新声明，避免已清空的工具被旧历史恢复。

缓存仅位于当前插件进程内：最多 128 条、32 MiB 数据预算、单条 4 MiB，闲置
30 分钟后在下次访问时清理。预算包含条目数据及估算元数据，不代表进程 RSS，
也不包含在途请求和子进程内存。进程重启、插件重载、到期、淘汰、超限或切换
账号/线程/模型都会使旧响应不可续接；届时返回明确错误，应重新发送完整历史。
历史尚在但工具目录已被淘汰时，需要显式重新提供完整 tools，避免悄悄丢失工具能力。
对话和工具正文不会写入缓存文件、日志或诊断结果。

非流式响应的 X-BPS-Continuation 为 cached 表示本次终态已缓存，
full-history-required 表示下次需要完整历史。流式响应提前返回 memory-limited，
表示按上述预算尝试缓存，不能保证最终大小允许保存。设置 continuationCache: false
可同时关闭续接和目录缓存，设置页也提供开关。

只缓存经过转换和校验的成功终态。失败、取消、截断不会生成可续接状态；响应 ID
碰撞会使该 ID 不可用，HTTP 401 会清理该账号的缓存。独立 compact 成功后保存
新的压缩窗口，下一轮不会把压缩前完整历史重新附加回来。

## 推理实现与边界

- Magpie hooks：config、OAuth methods、loader.fetch、refresh、usage、
  provider.models、chat.headers、tool。对宿主暴露 Responses API。
- 令牌提前五分钟续期，同一进程内并发刷新合并；Magpie 0.1.684+ 使用
  原生 refresh hook，旧宿主/OpenCode 由 fetch 路径补做刷新。
- 支持 HTTP /responses 的 SSE 与非流式 JSON、真实 usage、function/custom
  工具往返及 schema 校验。工具只有在完整终态整批验证后才交付给客户端。
- 支持独立 POST /responses/compact：转换为原生 compaction_trigger，禁用新工具，
  只有收到有效完整 compaction 状态才返回 response.compaction。该端点返回 JSON。
- fetch 支持 URL + init 及标准 Request 对象；取消请求体读取、总超时 504 和
  OAuth/额度/附件的流式大小限制均已覆盖。
- 支持 HTTPS 图片和内联图片。先校验整批请求，再以同一账号上传附件。
- 客户端取消会终止请求体生产者、上游和转换子进程；完整终态后释放上游连接。
  Request 对象的正文仅消费一次，已消费或被锁定的正文不能重复发送。
- 401/403/429 保留对应 HTTP 语义，429 传递有效 Retry-After，不自动重放
  已接受的推理。账号路由、并发和失败切换由 Magpie 管理。
- 每次推理使用独立 Go 转换进程，不监听端口，不访问网络，不执行 OfficeJS
  或工具正文。所有外部请求通过插件宿主 fetch 发出。

没有稳定会话头、缓存关闭或缓存不可用时，请传完整历史和工具目录。只给工具
结果且没有匹配原调用或有效 previous_response_id 会明确失败。图片生成/编辑端点、
独立 conversation 资源、后台任务和 WebSocket 暂未暴露。请求内原生 context_management
由适配器处理。格式纠错次数耗尽或操作一致性校验不通过时，工具调用明确失败。

JWT 解码是 TLS token exchange 后的一致性检查，不是对外认证的 JWT 验签器。
已完成已登录账号的只读模型目录验收；离线测试不能代替实际推理、额度权限与计费验收。

## 构建与验证

~~~powershell
git clone https://github.com/pdxxxx/bps-magpie.git
cd bps-magpie
npm run build
npm test
$tests = Get-ChildItem tests -Filter '*.test.mjs' | ForEach-Object FullName
bun test @tests
~~~

构建需要 Node.js 22+（或 Bun）与 Go 1.27.4+。构建后运行时只需 Magpie 自带
Bun 和 bin/ 内对应平台的程序，不需要 Go 或其他网关服务。

设置 TARGET_OS=linux|darwin|win32 和 TARGET_ARCH=x64|arm64 可交叉编译。
Magpie 不执行 npm postinstall，所以发布源码包时需自行构建相应二进制。
包中保留完整 Go 源码、许可证和第三方声明。

~~~text
index.mjs               插件 hooks
src/auth.mjs            授权与续期
src/provider.mjs        推理传输
src/bridge.mjs          本地转换 IPC
src/quota.mjs           额度、点数与重置接口
src/management.mjs      账号工具与防重复消费回执
src/network.mjs         统一代理与有界 JSON 读取
src/state.mjs           账号/线程隔离的有界会话缓存
src/events.mjs          流式终态观察
src/diagnostics.mjs     无网络的本地诊断
src/models.mjs          从上游权限接口自动同步模型
ui/                     精简的 Magpie 内嵌设置页
bridge/                 固定版本协议实现与 Go 测试
tests/                  插件端到端离线测试
bin/                    各平台编译产物
~~~

来源与修改记录见 provenance.json、NOTICE.md，验收结果见 VALIDATION.md。
