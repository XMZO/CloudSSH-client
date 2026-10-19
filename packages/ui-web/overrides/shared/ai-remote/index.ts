/**
 * AI 跨服务器操作（电脑与手机共用，不改 Worker）：AI 知道还有哪些服务器（名称、分类、系统、线路），
 * 说出名字就能在其他服务器上执行命令、在服务器之间传文件或目录。
 *
 *   protocol.ts  给 AI 的服务器目录与用法、AI 回复里的 cloudssh-action 动作解析、结果格式
 *   servers.ts   服务器列表、按名字查找、提到别的服务器的判断
 *   session.ts   无界面的后台 SSH 会话（用保存的凭据自动登录、自动走跳板与隧道），执行命令
 *   sftp.ts      无界面的 SFTP 通道（中转传输用）
 *   transfer.ts  传文件：同机复制 → 服务器直连（一次性密钥）→ 经客户端中转
 *   safety.ts    命令护栏（与 Worker 的 AI 助手同一套规则）
 *   runner.ts    编排：取出动作 → 护栏与确认（跟随面板的交互/自动模式）→ 执行 → 结果回传 AI
 *   ui.ts        面板里的操作卡片
 * 由 agent-output 安装（服务器目录附在发出的消息里，见 agent-output/outbound.ts）。
 */
import { installRunner } from './runner';
import './ai-remote.css';

export function installAiRemote(): void {
  installRunner();
}
