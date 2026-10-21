# CloudSSH 远程 MCP（Muse 等云端 AI 的连接器）

Meta Muse 这类云端助手不能安装 skill，也碰不到你电脑上的 `cloudssh`，但能接**自定义连接器**：一个公网 HTTPS 的远程 MCP 地址，用 OAuth 授权。`cloudssh mcp http` 就是这样一个服务器，放在一台常开的服务器上，经 CloudSSH 操作你保存的服务器（与命令行同一套：跳板、隧道、主机 ID、64KB 输出上限）。

- **工具**：`list_servers`、`exec`（可带 `cwd`）、`read_file`、`list_dir`、`write_file`、`edit_file`、`start_job`、`job_status`、`copy`（只读时没有 `write_file`、`edit_file`、`copy`）。文件内容走 SFTP：读写不受命令输出 64KB 的限制、不用 Shell 转义；长任务用 `start_job` 在后台跑、`job_status` 查看。`upload` / `download` 读写的是这台服务器的磁盘，对远程客户端没意义，不提供
- **权限**（`ACCESS`）：`full` 与命令行的完全权限一样，危险命令直接执行（`rm -rf /` 这类拦截级仍拒绝）；`ask` 危险命令要 AI 先问你、再带 `confirm: true`；`read-only` 只放行查看类命令（文件、日志、状态、进程、网络、磁盘、容器），写文件、重定向到文件、安装、重启、删除、命令替换、子 Shell、heredoc、解释器一律拒绝。只读判定是尽力而为的护栏，不是沙箱
- **不提供的服务器**（`EXCLUDE`）：跑这个服务的机器自己。它上面存着 CloudSSH 的登录，能在它上面执行命令就能读到登录
- **授权**：只认一个人。Muse 添加连接器时打开授权页，输入部署时设的口令（只存 scrypt 哈希）；连续输错 5 次后锁定，1 分钟起、最长 15 分钟。令牌只存 SHA-256，访问令牌 1 小时、刷新令牌 30 天（每用一次换新的）
- **固定令牌**（可选）：有的应用添加自定义 MCP 时只能填一个固定的 Bearer 令牌或请求头，不会走 OAuth（也就不会自动刷新 1 小时的访问令牌）。给它们生成固定令牌：`.env` 的 `STATIC_TOKENS` 里只存令牌的 SHA-256，可以带名字（`名字:哈希`，多个逗号隔开），不过期，删掉那一项再 `docker compose up -d` 即吊销；权限与 `ACCESS` 一样。令牌本身只在生成时显示一次，在应用里填请求头 `Authorization: Bearer <令牌>`。第一次使用时日志记一行 `固定令牌 名字 开始使用`
- **审计**：每次执行、拒绝都在容器日志里记一行（工具、主机 ID、命令前 300 字）：`docker compose logs -f`

## 部署（以 /root/cloudssh 为例）

1. 放文件：`compose.yaml`、`cloudssh.mjs`（`packages/cli/dist/cloudssh.mjs`，`pnpm cli:build` 打包），建数据目录：
   ```bash
   mkdir -p /root/cloudssh/data && chown 1000:1000 /root/cloudssh/data && chmod 700 /root/cloudssh/data
   ```
2. 生成口令哈希（至少 12 个字符），写进 `.env`（照 `.env.example`，`chmod 600 .env`）：
   ```bash
   docker run --rm -it -v "$PWD/cloudssh.mjs:/app/cloudssh.mjs:ro" node:24-slim node /app/cloudssh.mjs mcp http --hash-password
   ```
3. 登录 CloudSSH（会话 7 天过期，到期重做这一步）：
   ```bash
   docker compose run --rm cloudssh-mcp node /app/cloudssh.mjs login --start https://你的 CloudSSH 地址
   ```
   打开它打印的链接，在浏览器里用 GitHub 授权；回到 CloudSSH 页面后（页面显示 “Invalid state parameter” 是正常的）复制地址栏的完整地址，10 分钟内运行：
   ```bash
   docker compose run --rm cloudssh-mcp node /app/cloudssh.mjs login --callback "<复制的地址>"
   ```
4. 启动：`docker compose up -d`，`docker compose logs` 里应有 `listening on http://0.0.0.0:8790（对外 …/mcp，权限 full，CloudSSH 实例 …）`
5. HTTPS：照 `Caddyfile.example` 给域名加一段，DNS 的 A / AAAA 记录直接指向这台服务器（不开 Cloudflare 代理）
6. 在 Muse 里：设置 → 连接器 → 添加自定义连接器，地址填 `https://你的域名/mcp`，在弹出的授权页输入口令
7. （可选）只能填固定令牌的应用：生成令牌，把第二行加进 `.env` 的 `STATIC_TOKENS`，`docker compose up -d` 让它生效；第一行（令牌）填进应用，地址同样是 `https://你的域名/mcp`
   ```bash
   docker run --rm -v "$PWD/cloudssh.mjs:/app/cloudssh.mjs:ro" node:24-slim node /app/cloudssh.mjs mcp http --new-token --label 名字
   ```

更新：替换 `cloudssh.mjs` 后 `docker compose restart`。撤销所有授权：删掉 `data/cloudssh/mcp-http.json` 后重启。

## 接口

| 路径 | 说明 |
| --- | --- |
| `POST /mcp` | MCP（Streamable HTTP，JSON 回复；只有通知时 202）。没带或带了无效令牌回 401 + `WWW-Authenticate: Bearer resource_metadata=…` |
| `GET /.well-known/oauth-protected-resource` | 资源元数据（RFC 9728） |
| `GET /.well-known/oauth-authorization-server` | 授权服务器元数据（RFC 8414），`/.well-known/openid-configuration` 同一份 |
| `POST /register` | 动态注册客户端（RFC 7591），回调地址要是 https（或本机 http），每小时最多 30 个 |
| `GET/POST /authorize` | 授权页（口令），只支持 PKCE S256；也认 Client ID Metadata Document（client_id 是 https 地址） |
| `POST /token`、`POST /revoke` | 换 / 刷新 / 吊销令牌 |
