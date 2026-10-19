# CloudSSH AI 增强代理（思考深度、联网搜索）

CloudSSH 的 Worker 调模型时只带 `model / input / tools` 等固定字段，不会带 `reasoning.effort`，也不会开模型自己的联网搜索。这个代理是一个独立的 Cloudflare Worker（不需要改 CloudSSH），放在 CloudSSH 和模型接口之间：

1. 客户端在每条发给 AI 的消息末尾附指令标签，例如 `<cloudssh_reasoning effort="high"/> <cloudssh_web_search mode="on"/>`（AI 面板输入框下方的“思考深度”和“联网”）
2. 代理转发前删掉请求里所有这类标签（包括 Worker 整理上下文时嵌进 JSON 文本、引号被转义的），按最后一个改写请求：加上 `reasoning.effort`（`auto` 表示不加），开了联网时加上模型的原生搜索工具。0.3.23 客户端的旧写法 `[cloudssh-reasoning:high]` 同样识别
3. 其他请求（模型列表等）原样转发到 `UPSTREAM`，流式输出原样回传

每条消息各自带标签，所以切换思考深度、开关联网都不用开新会话。客户端只在检测到代理（`GET <接口地址>/cloudssh-reasoning`，返回版本与功能）时才附标签；版本 1 的旧代理用旧写法，版本 3 起才有联网搜索（已部署旧版的，重新复制代码部署即可）。

## 联网搜索

开了“联网”时，代理只给带函数工具的主对话加搜索工具（Worker 整理上下文、提炼记忆的结构化请求不加），模型在接口那边自己搜索，回答带来源链接。

- **搜索工具**：`UPSTREAM` 是 OpenRouter 时用 `{"type":"openrouter:web_search","parameters":{"engine":"native"}}`，GPT、Claude、Gemini 都优先用各家原生搜索（不支持原生搜索的模型由 OpenRouter 退回 Exa）；其他接口用 OpenAI Responses 的 `{"type":"web_search"}`，中转要自己支持把它转给 Claude / Gemini
- **自定义**（变量 `WEB_SEARCH`）：`off` 关闭；一个工具 JSON 表示所有模型都用它；或按模型名分开（键是模型名里包含的字样，按顺序匹配，`default` 兜底），例如中转直接透传各家原生工具时：
  `{"claude":{"type":"web_search_20250305","name":"web_search","max_uses":5},"gemini":{"type":"google_search"},"default":{"type":"web_search"}}`
- **结果整理**：搜索会在结果里多出 `web_search_call` 这类内置工具条目，CloudSSH 的 Worker 只接受消息、函数调用和推理条目，代理把其他条目从最终结果里去掉（流式输出只改 `response.completed` 那一帧，其他帧照常逐帧转发），带引用的回答照常保留
- **不支持时**：接口对搜索工具报 400 / 422（模型不支持搜索、或 GPT-5 在 minimal 档位不能搜索等）时，代理自动去掉搜索工具重发一次，日志里记 `"webSearch":"unsupported"`
- 联网搜索按服务商的价格另行计费（每次搜索单独收费），不用时关掉

请求链路是 **CloudSSH 的 Worker → 代理 → 模型接口**，设备只直接访问代理一次做检测。

## 部署

**Cloudflare 控制台**（客户端里“思考深度 → 部署方法”可以一键复制代码）：

1. Workers 和 Pages → 创建 Worker（从 Hello World 开始），部署后点“编辑代码”，把代码换成 [`worker.js`](worker.js) 的内容再部署
2. 设置 → 变量和机密：添加 `UPSTREAM`，值为原来在 CloudSSH 的 AI 设置里填的接口地址（如 `https://api.openai.com/v1`）
3. 在 CloudSSH 的 AI 设置里把接口地址改成这个 Worker 的地址（如 `https://cloudssh-reasoning.xxx.workers.dev`），重新填一次 API 密钥并保存

**wrangler**：把 `wrangler.toml` 里的 `UPSTREAM` 改成你的接口地址，然后在本目录运行 `npx wrangler deploy`。

## 部署位置

Cloudflare 不允许同一区域（zone）内的 Worker 互相请求（错误 1042，`*.workers.dev` 上有时是 522），除非发起请求的 Worker 打开 `global_fetch_strictly_public` 兼容标志（那要改 CloudSSH 的配置）。所以：

- 代理**不要**放在与 CloudSSH 相同的域名下（例如 CloudSSH 用 `bash.al`，代理就不要用 `*.bash.al`）
- 最稳妥：绑定到另一个域名的子域名，或部署在另一个 Cloudflare 账号里
- 用 `workers.dev` 地址时请发一条消息实际验证：客户端检测显示“已生效”只说明设备能访问代理；若 CloudSSH 的 Worker 访问不到，发消息会报“Responses API 请求失败（HTTP 5xx）”，客户端会给出上述提示

## 确认是否生效

- **代理日志**：Cloudflare 控制台 → 这个 Worker → 日志（实时日志或 Workers Logs；用 wrangler 部署时 `wrangler.toml` 已开启 observability）。每个 `/responses` 请求一行，例如 `{"cloudsshReasoning":"high","applied":true,"webSearch":"on","searches":2,"model":"gpt-5","status":200,"reasoningTokens":812,"inputTokens":9120,"cachedTokens":7680,"cacheHit":"84%"}`：`applied` 为 true 表示已给请求加上 `reasoning.effort`，`webSearch` 是联网搜索（`on` 已加搜索工具、`off` 没开、`unsupported` 接口不支持已去掉重发、`skipped` 结构化请求不加），`searches` 是这次去掉的搜索条目数（大于 0 说明模型真的搜索了），`reasoningTokens` 是接口回报的推理 token 数，`cachedTokens` / `cacheHit` 是输入里缓存命中的部分（代理删掉标签的方式是固定的，不影响缓存）
- **对比推理用量**：用不同档位问同一个问题，`reasoningTokens`（客户端思考深度菜单里也显示上一轮的推理用量）应明显变化；一直为 0 或不变，说明模型或中转没有应用这个参数
- 只有 `status` 不是 200：看状态码排查（400 多半是模型不支持这一档；5xx 可能是 `UPSTREAM` 不通）。如果 CloudSSH 报错而这里一行日志都没有，说明请求根本没到代理，多半是上面说的同区域限制

## 说明

- API 密钥只是经过代理转给 `UPSTREAM`，代理不保存、不记录；日志只有档位、模型、状态码和 token 用量，不含密钥与对话内容；代理只会转发到 `UPSTREAM`（必须是 https）
- 代理地址后面的路径接到 `UPSTREAM` 后面，两边都带 `/v1` 时只保留一个
- 模型不支持 `reasoning.effort`（或不支持选的那一档）时接口会报 400，客户端会提示把思考深度改回“自动”
