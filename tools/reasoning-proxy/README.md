# CloudSSH AI 增强代理（思考深度、联网搜索、长上下文、中转兼容）

CloudSSH 的 Worker 调模型时只带 `model / input / tools` 等固定字段，不会带 `reasoning.effort`，也不会开模型自己的联网搜索；而且不论什么模型，每段对话都只留约 37KB（一万出头 token）就整理成摘要。这个代理是一个独立的 Cloudflare Worker（不需要改 CloudSSH），放在 CloudSSH 和模型接口之间：

1. 客户端在每条发给 AI 的消息末尾附指令标签，例如 `<cloudssh_reasoning effort="high"/> <cloudssh_web_search mode="on"/>`（AI 面板输入框下方的“思考深度”和“联网”）
2. 代理转发前删掉请求里所有这类标签（包括 Worker 整理上下文时嵌进 JSON 文本、引号被转义的），按最后一个改写请求：加上 `reasoning.effort`（`auto` 表示不加），开了联网时加上模型的原生搜索工具。0.3.23 客户端的旧写法 `[cloudssh-reasoning:high]` 同样识别
3. 其他请求（模型列表等）原样转发到 `UPSTREAM`，流式输出原样回传

每条消息各自带标签，所以切换思考深度、开关联网都不用开新会话。客户端只在检测到代理（`GET <接口地址>/cloudssh-reasoning?model=<模型>`，返回版本、功能与模型窗口）时才附标签；版本 1 的旧代理用旧写法，版本 3 起有联网搜索，版本 4 起有长上下文，版本 5 起改写结果里的 `store: true`，版本 6 起补全最后一帧缺的结果（已部署旧版的，重新复制代码部署即可）。

## 长上下文（版本 4 起）

CloudSSH 的 Worker 按 UTF-8 字节给每段对话留约 37760 字节（系统提示和工具定义就占约 11KB），到了就让模型把前文写成一份严格格式的 JSON 检查点，之后只带这份检查点。不论模型窗口多大都一样，小模型还常常写不出这份 JSON（“结构化输出校验失败”）。代理接管这一步：

- **整理请求**（`text.format.name` 为 `agent_checkpoint`）不发给模型。Worker 随请求带来了这一段的完整记录（用户消息、回复、工具调用和结果，单条工具输出最多 4000 字），代理把它接在之前保存的记录后面存起来，当场交回一份合格的检查点（目标、最近的操作和回复、一个记录编号 `cloudssh-history:<id>`）。不花钱、不等待，也不会再校验失败
- **之后的请求**里出现这份检查点时，按编号把完整前文放在检查点前面再发给模型（仍是一条“不可信观察”，与 Worker 的安全约定一致）。最多放到模型窗口的约 85% 扣掉输出（按每 token 3 字节估），放不下时去掉最早的部分；接口报超出上下文（400 / 413 且错误里提到 context / too long 等）时缩小一半重发，并记住这个模型的上限 30 分钟
- **模型窗口**：变量 `CONTEXT_TOKENS`（一个数，或按模型名分开：`{"gpt-5":272000,"default":128000}`）→ 接口的 `/models` 列表里的 `context_length` 等字段（OpenRouter 有，缓存 6 小时）→ 内置的常见模型表（GPT-5 系列 272K、Claude 200K、Gemini 1M、GPT-4.1 1M、DeepSeek / GLM / 通义 / Kimi 约 128K 等）→ 认不出按 128K
- **放回多少**：变量 `MAX_CONTEXT_BYTES` 限制放回的前文最多多少字节（默认 1200000，约三四十万 token；填 0 相当于不放回）。前文越长每次请求越贵，接口的提示缓存（上下文弹窗里的“缓存命中”）能省掉大部分
- **存在哪**：代理的内存（同一个实例里最快）→ Cloudflare 缓存（绑定了自定义域名时可用）→ KV。内存会被 Cloudflare 回收，长对话建议绑定 KV（见下面的部署）。找不到前文时模型只看到那份检查点，相当于普通的整理，不会出错
- **回给 Worker 的用量**：放回前文后实际输入远超 Worker 的预算，Worker 会以为满了、每一步都整理。所以代理把回给 Worker 的输入 token 改成不超过 Worker 那份请求体字节数 / 4，实际输入编进缓存 token（`缓存 + 输入 × 2^26`），客户端解开后按实际输入对比模型窗口显示占用。输出与推理 token 不改；Worker 只把这些数用于判断整理和统计，网页版界面不显示
- 关闭：变量 `LONG_CONTEXT=off`（整理请求照常发给模型，用量不改）

## 联网搜索

开了“联网”时，代理只给带函数工具的主对话加搜索工具（Worker 整理上下文、提炼记忆的结构化请求不加），模型在接口那边自己搜索，回答带来源链接。

- **搜索工具**：`UPSTREAM` 是 OpenRouter 时用 `{"type":"openrouter:web_search","parameters":{"engine":"native"}}`，GPT、Claude、Gemini 都优先用各家原生搜索（不支持原生搜索的模型由 OpenRouter 退回 Exa）；其他接口用 OpenAI Responses 的 `{"type":"web_search"}`，中转要自己支持把它转给 Claude / Gemini
- **自定义**（变量 `WEB_SEARCH`）：`off` 关闭；一个工具 JSON 表示所有模型都用它；或按模型名分开（键是模型名里包含的字样，按顺序匹配，`default` 兜底），例如中转直接透传各家原生工具时：
  `{"claude":{"type":"web_search_20250305","name":"web_search","max_uses":5},"gemini":{"type":"google_search"},"default":{"type":"web_search"}}`
- **结果整理**：搜索会在结果里多出 `web_search_call` 这类内置工具条目，CloudSSH 的 Worker 只接受消息、函数调用和推理条目，代理把其他条目从最终结果里去掉（流式输出只改 `response.completed` 那一帧，其他帧照常逐帧转发），带引用的回答照常保留
- **不支持时**：接口对搜索工具报 400 / 422（模型不支持搜索、或 GPT-5 在 minimal 档位不能搜索等）时，代理自动去掉搜索工具重发一次，日志里记 `"webSearch":"unsupported"`
- 联网搜索按服务商的价格另行计费（每次搜索单独收费），不用时关掉

请求链路是 **CloudSSH 的 Worker → 代理 → 模型接口**，设备只直接访问代理一次做检测。

## 结果里的 store:true（版本 5 起）

CloudSSH 的 Worker 每个请求都带 `store: false`（不让服务商保存对话），结果里写着 `store: true` 就当作服务商没照办，整轮失败，AI 面板显示“服务商未按要求使用无状态 Responses 模式（返回了 store:true）”。不少中转（尤其转接 Gemini、Claude 的）不管请求怎么写，结果里都填 `store: true`。

- 代理把结果对象里的 `store: true` 改成 `false`（流式输出只改 `response.completed` / `response.incomplete` 那一帧，其他帧原样转发），日志那一行多一个 `"store":"rewritten"`
- 这只是让 Worker 不再拦下：中转到底有没有保存对话，要看中转自己。介意的话换一个遵守 `store: false` 的接口
- 关闭：变量 `STORE_FIX=off`（结果原样转发，Worker 照旧拦下）

## 最后一帧缺结果（版本 6 起）

Worker 只认流式输出最后的 `response.completed` 里的结果对象。有的中转那一帧的 `output` 是空的或只剩推理，正文和函数调用只在前面的帧里（`response.output_item.done`、`response.output_text.delta`）给过，AI 面板就会显示“模型未返回正文或工具调用，任务未被标记为完成”。

- 代理把前面帧里完整给出的条目补进最后一帧（只留 Worker 认的消息、函数调用、推理）；没有条目、只有正文增量时拼成一条消息。日志记 `"output":"rebuilt"`（或 `"rebuilt-text"`），`upstreamOutput` 是中转原来给的条目类型
- 前面的帧也什么都没给时不改，日志记 `upstreamOutput`、`streamedItems`、`streamedText`（只有类型和计数），说明模型或中转确实没回内容
- 前面的帧只是原样记下，最后一帧缺内容时才解析，平时不多花时间

## 部署

**Cloudflare 控制台**（客户端里“思考深度 → 部署方法”可以一键复制代码）：

1. Workers 和 Pages → 创建 Worker（从 Hello World 开始），部署后点“编辑代码”，把代码换成 [`worker.js`](worker.js) 的内容再部署
2. 设置 → 变量和机密：添加 `UPSTREAM`，值为原来在 CloudSSH 的 AI 设置里填的接口地址（如 `https://api.openai.com/v1`）
3. （长上下文，建议）存储和数据库 → KV → 创建命名空间（名字随意，如 `reasoning-history`）；回到这个 Worker 的 设置 → 绑定 → 添加 → KV 命名空间，变量名填 `HISTORY`。前文保存 3 天；每次 Worker 整理写一次，免费额度够用
4. 在 CloudSSH 的 AI 设置里把接口地址改成这个 Worker 的地址（如 `https://cloudssh-reasoning.xxx.workers.dev`），重新填一次 API 密钥并保存

**wrangler**：把 `wrangler.toml` 里的 `UPSTREAM` 改成你的接口地址，按里面的注释填上 KV 命名空间 ID（`npx wrangler kv namespace create reasoning-history` 创建），然后在本目录运行 `npx wrangler deploy`。注意 `[vars]` 会覆盖控制台里同名的变量。

## 部署位置

Cloudflare 不允许同一区域（zone）内的 Worker 互相请求（错误 1042，`*.workers.dev` 上有时是 522），除非发起请求的 Worker 打开 `global_fetch_strictly_public` 兼容标志（那要改 CloudSSH 的配置）。所以：

- 代理**不要**放在与 CloudSSH 相同的域名下（例如 CloudSSH 用 `bash.al`，代理就不要用 `*.bash.al`）
- 最稳妥：绑定到另一个域名的子域名，或部署在另一个 Cloudflare 账号里
- 用 `workers.dev` 地址时请发一条消息实际验证：客户端检测显示“已生效”只说明设备能访问代理；若 CloudSSH 的 Worker 访问不到，发消息会报“Responses API 请求失败（HTTP 5xx）”，客户端会给出上述提示

## 确认是否生效

- **代理日志**：Cloudflare 控制台 → 这个 Worker → 日志（实时日志或 Workers Logs；用 wrangler 部署时 `wrangler.toml` 已开启 observability）。每个 `/responses` 请求一行，例如 `{"cloudsshReasoning":"high","applied":true,"webSearch":"on","searches":2,"model":"gpt-5","context":"expanded","historyBytes":182340,"window":272000,"status":200,"reasoningTokens":812,"inputTokens":61120,"cachedTokens":57680,"cacheHit":"94%"}`：`context` 是长上下文（`none` 还没整理过、`expanded` 已放回完整前文、`trimmed` 放回时去掉了最早的部分、`missing` 前文找不到了、`skipped` 没放回），`historyBytes` 是放回了多少字节，`inputTokens` / `cachedTokens` 是接口回报的实际值；`applied` 为 true 表示已给请求加上 `reasoning.effort`，`webSearch` 是联网搜索（`on` 已加搜索工具、`off` 没开、`unsupported` 接口不支持已去掉重发、`skipped` 结构化请求不加），`searches` 是这次去掉的搜索条目数（大于 0 说明模型真的搜索了），`reasoningTokens` 是接口回报的推理 token 数，`cachedTokens` / `cacheHit` 是输入里缓存命中的部分（代理删掉标签的方式是固定的，不影响缓存），`store` 为 `rewritten` 表示接口在结果里回了 `store: true`、已改成 `false`，`outputTokens` 是接口回报的输出 token 数，`error` 是接口报错时的错误码与说明（如 429 是限流还是额度用完；像密钥的片段打码，最多 200 字），`output` / `upstreamOutput` / `streamedItems` / `streamedText` 见上面的“最后一帧缺结果”
- **长上下文**：Worker 整理时记一行 `{"cloudsshCheckpoint":"kept","records":38,"continued":true,"historyBytes":182340,"storage":"kv"}`（`continued` 表示接上了之前保存的记录）；之后的请求 `context` 应为 `expanded`
- **对比推理用量**：用不同档位问同一个问题，`reasoningTokens`（客户端思考深度菜单里也显示上一轮的推理用量）应明显变化；一直为 0 或不变，说明模型或中转没有应用这个参数
- 只有 `status` 不是 200：看状态码排查（400 多半是模型不支持这一档；5xx 可能是 `UPSTREAM` 不通）。如果 CloudSSH 报错而这里一行日志都没有，说明请求根本没到代理，多半是上面说的同区域限制

## 说明

- API 密钥只是经过代理转给 `UPSTREAM`，代理不保存、不记录；日志只有档位、模型、状态码、上下文大小和 token 用量，不含密钥与对话内容；代理只会转发到 `UPSTREAM`（必须是 https）。查模型窗口时代理会用同一个密钥请求 `UPSTREAM` 的 `/models`
- 长上下文的对话记录只存在代理的内存、Cloudflare 缓存和你绑定的 KV 里（3 天后过期），记录编号是随机的
- 代理地址后面的路径接到 `UPSTREAM` 后面，两边都带 `/v1` 时只保留一个
- 模型不支持 `reasoning.effort`（或不支持选的那一档）时接口会报 400，客户端会提示把思考深度改回“自动”
