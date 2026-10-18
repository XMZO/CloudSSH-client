/**
 * 桌面端对网页版 UI 的定制入口（构建时注入，不修改 upstream 源码）。
 *
 * 可以在这里：
 * - 引入额外样式：import './desktop.css';
 * - 读取桌面桥接信息：window.cloudsshDesktop（由客户端 preload 注入，网页环境下不存在）
 * - 监听/增强 DOM（尽量做成可选、失败无害，避免上游改版后报错）
 *
 * 已有定制：
 * - sidebar/：左侧节点侧栏（按标签分组、搜索、双击连接、会话指示）
 * - shared/language-picker.ts：语言按钮显示当前语言，点开下拉选择
 * - shared/web-fixes.css：网页版界面的通用修正（与手机端共用）
 * - shared/terminal/：内置终端字体与关键词高亮（与手机端共用）
 * - desktop/：界面主题（工作台 / 经典）：自绘标题栏、表格化服务器列表、终端占满窗口
 * - shared/server-tags.ts：添加服务器时点选已有标签，标签重命名、复制（与手机端共用）
 */
import './desktop.css';
import './shared/web-fixes.css';
import { installLanguagePicker, popoverLanguageMenu } from './shared/language-picker';
import { installTagPicker } from './shared/server-tags';
import { installTerminalEnhancements } from './shared/terminal';
import { mountDesktopShell } from './desktop';
import { mountSidebar } from './sidebar/sidebar';

document.documentElement.dataset.cloudsshClient = 'desktop';
// 要在网页版创建第一个终端之前装好（构建钩子在创建终端时回调）
installTerminalEnhancements();

window.cloudsshDesktop
  ?.info()
  .then((info) => {
    document.documentElement.dataset.cloudsshPlatform = info.platform;
  })
  .catch(() => {
    // 桥接不可用时保持网页版原样
  });

mountSidebar();
installLanguagePicker(popoverLanguageMenu);
// 添加 / 编辑服务器时点选已有标签
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installTagPicker, { once: true });
else installTagPicker();
void mountDesktopShell();
