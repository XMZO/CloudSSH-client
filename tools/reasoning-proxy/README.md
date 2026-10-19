# CloudSSH 思考深度代理

CloudSSH 的 Worker 调模型时只带 `model / input / tools` 等固定字段，不会带 `reasoning.effort`。这个代理是一个独立的 Cloudflare Worker（约 50 行，不需要改 CloudSSH），放在 CloudSSH 和模型接口之间：

1. 客户端在每条发给 AI 的消息末尾附一个标记，例如 `[cloudssh-reasoning:high]`（AI 面板输入框下方的“思考深度”）
2. 代理转发前删掉请求里所有这类标记，按最后一个标记给请求加上 `reasoning.effort`；`auto` 表示不加，用服务商默认
3. 其他请求（模型列表等）原样转发到 `UPSTREAM`，流式输出原样回传

每条消息各自带标记，所以切换思考深度不用开新会话。客户端只在检测到代理（`GET <接口地址>/cloudssh-reasoning`）时才附标记。

## 部署

**Cloudflare 控制台**（客户端里“思考深度 → 部署方法”可以一键复制代码）：

1. Workers 和 Pages → 创建 Worker（从 Hello World 开始），部署后点“编辑代码”，把代码换成 [`worker.js`](worker.js) 的内容再部署
2. 设置 → 变量和机密：添加 `UPSTREAM`，值为原来在 CloudSSH 的 AI 设置里填的接口地址（如 `https://api.openai.com/v1`）
3. 在 CloudSSH 的 AI 设置里把接口地址改成这个 Worker 的地址（如 `https://cloudssh-reasoning.xxx.workers.dev`），重新填一次 API 密钥并保存

**wrangler**：把 `wrangler.toml` 里的 `UPSTREAM` 改成你的接口地址，然后在本目录运行 `npx wrangler deploy`。

## 说明

- API 密钥只是经过代理转给 `UPSTREAM`，代理不保存、不记录；代理只会转发到 `UPSTREAM`（必须是 https）
- 代理地址后面的路径接到 `UPSTREAM` 后面，两边都带 `/v1` 时只保留一个
- 模型不支持 `reasoning.effort`（或不支持选的那一档）时接口会报 400，客户端会提示把思考深度改回“自动”
