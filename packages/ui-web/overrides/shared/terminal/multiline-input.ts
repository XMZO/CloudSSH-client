/**
 * 当成打字送进来的整段文字（电脑与手机共用，手机上最常见）：多行按粘贴整段送出，换行按回车送。
 *
 * 粘贴事件（系统菜单的“粘贴”、Ctrl+V、快捷栏的粘贴按钮）走 xterm 的 paste()：换行换成回车（\r），远端开了括号粘贴模式
 * （bash 5.1 起、nano 都会开）时整段包在 ESC[200~ … ESC[201~ 里，shell 里按回车才一起执行，nano 里原样放在光标处。
 * 可有的入口把文字当成“打字”送进来：输入法的剪贴板栏（commitText，浏览器里是 insertText）、iOS 输入法的补发（keyCode 229），
 * 还可能分几次提交（每次一行加换行）。这些文字原样发出去：
 * - shell 里每个换行都是一次回车，第一行马上执行，后面几行常被它读走（apt 的“是否继续？[Y/n]”读到下一行就放弃了）
 * - nano 里换行是 \n，也就是 Ctrl+J（对齐段落），把段落重新排版，内容跑到下面或几行之外
 *
 * 现在：一次输入里换行后面还有文字、远端开着括号粘贴模式时改走 paste()，和粘贴事件一样；其余的整段文字里的换行一律换成 \r，
 * 和按回车一样。单独一个 \n（键盘上真按了 Ctrl+J）不动。
 */
import type { Terminal } from '@xterm/xterm';

interface InputTerminal {
  terminal?: Terminal;
}

/** 换行后面还有别的字 */
const MULTILINE = /\n[^\n]/;

/**
 * 返回 null：已改走 paste()，这次输入不用再发；返回字符串：换行换成回车后的内容；undefined：原样。
 * 构建钩子在网页版处理键盘输入的入口调用。
 */
function terminalText(owner: InputTerminal, data: string): string | null | undefined {
  const term = owner.terminal;
  if (!term || data.length < 2 || data.startsWith('\x1b') || !/[\r\n]/.test(data)) return undefined;
  const text = data.replace(/\r\n?/g, '\n');
  // paste() 发出来的带 ESC[200~，回到这里时不再改道；没开括号粘贴模式时不调它（发出来的还是多行，会一直绕回来）
  if (MULTILINE.test(text) && term.modes.bracketedPasteMode) {
    term.paste(text);
    return null;
  }
  return text.includes('\n') ? text.replace(/\n/g, '\r') : undefined;
}

let installed = false;

export function installMultilineInput(): void {
  if (installed) return;
  installed = true;
  (globalThis as { __cloudsshTerminalText?: typeof terminalText }).__cloudsshTerminalText = terminalText;
}
