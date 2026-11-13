/**
 * 给 AI 的文字一律用英文。客户端共用的 ai-remote 模块（会话、SFTP、传输、危险命令规则）的报错与原因是中文的（应用界面要显示），
 * 命令行与 MCP 交给模型之前在这里换成英文；认不出的（例如 Worker 原样转来的报错）照原样返回。
 * ai-remote 里改了这些句子时，这里要跟着改。
 */

/** 危险命令规则（ai-remote/safety.ts）的原因 */
const SAFETY: Record<string, string> = {
  '禁止执行 Fork Bomb (资源耗尽攻击)': 'fork bomb',
  '禁止执行高危删除操作 (rm -rf /)': 'rm -rf of /, /*, ~ or *',
  '禁止在 rm -rf 中使用 shell 替换（可能展开为根目录）': 'shell substitution in rm -rf (may expand to /)',
  '禁止格式化磁盘': 'formats a disk (mkfs)',
  '禁止覆盖块设备': 'overwrites a block device (dd of=/dev/…)',
  '使用 IFS 动态构造命令': 'builds a command with $IFS',
  'eval 动态执行命令': 'eval',
  'Shell 包裹或脚本执行': 'runs a shell (sh, bash, …) or shell script',
  '解释器执行代码或脚本': 'runs an interpreter (python, perl, node, awk, …) or script',
  'Shell 动态代码执行': 'shell -c with inline code',
  '解释器动态代码执行': 'interpreter with inline code (-c, -e, --eval)',
  '在当前 Shell 执行脚本': 'source / . runs a script in the current shell',
  '删除文件操作': 'deletes files',
  '重启服务器': 'reboots the server',
  '关闭服务器': 'shuts the server down',
  '停止服务器': 'halts the server',
  '关闭服务器电源': 'powers the server off',
  '更改运行级别(关机或重启)': 'changes the runlevel (shutdown or reboot)',
  '修改密码': 'changes a password',
  '递归修改文件所有者': 'changes file ownership recursively',
  '递归修改文件权限': 'changes file permissions recursively',
  '磁盘分区操作': 'partitions a disk',
  '低级磁盘拷贝/覆盖': 'low-level disk copy or overwrite (dd)',
  '清空防火墙规则': 'flushes firewall rules',
  '清空自定义链表': 'deletes custom firewall chains',
  '禁用防火墙': 'disables the firewall',
  '杀死全部进程': 'kills all processes',
  '杀死进程': 'kills processes with SIGKILL',
  '远程下载并执行脚本': 'downloads and runs a remote script',
  'find 递归删除文件': 'find deletes files',
  'find 递归执行 rm': 'find runs rm',
};

/** 危险命令的原因换成英文（需要确认的那类末尾带“，为保证安全需要确认”） */
export function safetyReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const base = reason.replace(/，为保证安全需要确认$/, '');
  return SAFETY[base] ?? english(base);
}

/** ai-remote 的报错：整句或带参数的句式，出现在哪都换（前面常带着“服务器名: ”）；长的在前，免得被短的先换掉一半 */
const PHRASES: Array<[RegExp, string]> = [
  // sftp.ts
  [/SFTP 连接已关闭（(\d+)）/g, 'SFTP connection closed ($1)'],
  [/SFTP 连接失败/g, 'SFTP connection failed'],
  [/SFTP 响应超时/g, 'SFTP response timed out'],
  [/SFTP 操作失败/g, 'SFTP operation failed'],
  [/SFTP 会话已关闭/g, 'SFTP session closed'],
  [/SFTP 已关闭/g, 'SFTP closed'],
  [/SFTP 已经打开/g, 'SFTP is already open'],
  [/文件太大（(\d+) 字节），超过中转上限/g, 'file too large ($1 bytes) for the relay limit'],
  [/文件超过中转上限，已取消/g, 'file exceeds the relay limit; cancelled'],
  [/目标文件已存在且无法覆盖/g, 'destination file exists and cannot be overwritten'],
  [/读取中转数据时提前结束/g, 'relay data ended early'],
  [/上传后校验失败（SHA-256 不一致）/g, 'verification after upload failed (SHA-256 mismatch)'],
  // session.ts
  [/Shell 就绪超时/g, 'timed out waiting for the shell to start'],
  [/连上 (\d+) 秒还没开始 SSH 握手（Cloudflare 连 SSH 服务器卡住了）/g, "no SSH handshake $1 s after connecting (Cloudflare's connection to the SSH server stalled)"],
  [/WebSocket 连接失败/g, 'WebSocket connection failed'],
  [/连接已关闭（(\d+)）/g, 'connection closed ($1)'],
  [/连接已关闭/g, 'connection closed'],
  [/这台服务器需要交互式认证，无法在后台登录/g, 'this server needs interactive authentication, which background sessions cannot do'],
  [/主机指纹已变化，请先在终端里连接一次并确认/g, 'the host key changed: the user must connect once in a CloudSSH terminal and accept the new key'],
  [/等待输出超时/g, 'timed out waiting for output'],
  [/无法初始化远程 Shell（可能不是 POSIX Shell）/g, 'could not initialize the remote shell (possibly not a POSIX shell)'],
  [/命令单行太长（超过约 3500 字节），请拆分或改用文件/g, 'a command line is too long (over ~3500 bytes): split it or write it to a file'],
  [/命令太长，请拆分或改用文件/g, 'command too long: split it or write it to a file'],
  [/会话已关闭/g, 'session closed'],
  // transfer.ts
  [/: 无法读取 /g, ': cannot read '],
  [/ 不存在(?=$|\n)/g, ' does not exist'],
  [/读不到 (.+?) 的主机公钥/g, 'cannot read the host public key of $1'],
  [/生成临时密钥失败/g, 'failed to generate a temporary key'],
  [/: 没有 SFTP 通道/g, ': no SFTP channel'],
];

export function english(text: string): string {
  if (!/[一-鿿]/.test(text)) return text;
  let out = text;
  for (const [pattern, replacement] of PHRASES) out = out.replace(pattern, replacement);
  return out;
}
