/**
 * 多行文字当作粘贴送出（电脑与手机共用，手机上最常见）。
 *
 * 粘贴事件（系统菜单的“粘贴”、Ctrl+V、快捷栏的粘贴按钮）走 xterm 的 paste()：远端开了括号粘贴模式（bash 5.1 起默认开）时
 * 整段包在 ESC[200~ … ESC[201~ 里，换行不会被当成回车，按回车才一起执行。可有的入口把多行文字当成“打字”送进来：
 * 输入法的剪贴板栏（commitText，浏览器里是 insertText）、iOS 输入法的补发（keyCode 229）。这些文字原样发出去，
 * 每个换行都是一次回车，第一行马上执行，后面几行留在输入里，常被第一条命令读走（apt 的“是否继续？[Y/n]”读到下一行就放弃了）。
 *
 * 现在一次输入里换行后面还有文字（真正的多行，不是打完一行按回车）、远端开着括号粘贴模式时，改走 paste()，和粘贴事件一样。
 * 远端没开括号粘贴模式时 paste() 也只是把换行换成回车，照原样发。
 */
import type { Terminal } from '@xterm/xterm';

interface InputTerminal {
  terminal?: Terminal;
}

/** 换行后面还有别的字（\r\n 算一个换行） */
const MULTILINE = /[\r\n][^\r\n]/;

function multilineInput(owner: InputTerminal, data: string): boolean {
  const term = owner.terminal;
  if (!term || data.startsWith('\x1b') || !MULTILINE.test(data.replace(/\r\n/g, '\n'))) return false;
  // 没开括号粘贴模式时 paste() 发出来的还是多行，会再回到这里：不改道
  if (!term.modes.bracketedPasteMode) return false;
  term.paste(data);
  return true;
}

let installed = false;

export function installMultilineInput(): void {
  if (installed) return;
  installed = true;
  (globalThis as { __cloudsshMultilineInput?: typeof multilineInput }).__cloudsshMultilineInput = multilineInput;
}
