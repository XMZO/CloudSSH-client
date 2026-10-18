/** AI 回复风格的界面文案，跟随网页版当前语言 */
import { getLocale } from '../../../upstream/frontend/src/i18n';

const zhCN = {
  button: 'AI 回复风格',
  title: 'AI 回复风格',
  intro: '发送时把下面这段提示附加在你的消息后面一起发给 AI（对话里不显示），让回复更简洁、结论在前、用 ✅ ⚠️ ❌ 标出状态，配合配色更好读。只保存在这台设备上。',
  enabled: '附加回复风格提示',
  promptLabel: '提示内容（建议用英文，模型理解最稳定）',
  cost: '约 {n} 个字符，每条消息都会带上，会占用少量上下文',
  reset: '恢复默认',
  cancel: '取消',
  save: '保存',
  saved: '已保存，下一条消息开始生效',
  empty: '提示内容为空时等同于关闭',
  settingsHint: '附加给 AI 的回复格式提示：结论在前、更简洁、用 ✅ ⚠️ ❌ 标状态',
};

type Key = keyof typeof zhCN;

const dictionaries: Record<string, Record<Key, string>> = {
  'zh-CN': zhCN,
  'zh-TW': {
    button: 'AI 回覆風格',
    title: 'AI 回覆風格',
    intro: '傳送時把下面這段提示附加在你的訊息後面一起傳給 AI（對話裡不顯示），讓回覆更簡潔、結論在前、用 ✅ ⚠️ ❌ 標出狀態，搭配配色更好讀。只儲存在這台裝置上。',
    enabled: '附加回覆風格提示',
    promptLabel: '提示內容（建議用英文，模型理解最穩定）',
    cost: '約 {n} 個字元，每則訊息都會帶上，會佔用少量上下文',
    reset: '恢復預設',
    cancel: '取消',
    save: '儲存',
    saved: '已儲存，下一則訊息開始生效',
    empty: '提示內容為空時等同於關閉',
    settingsHint: '附加給 AI 的回覆格式提示：結論在前、更簡潔、用 ✅ ⚠️ ❌ 標狀態',
  },
  'en-US': {
    button: 'AI reply style',
    title: 'AI reply style',
    intro: 'This prompt is appended to every message you send (it is not shown in the chat) so replies are shorter, lead with the conclusion and mark status with ✅ ⚠️ ❌, which the panel colors. Stored on this device only.',
    enabled: 'Append the reply style prompt',
    promptLabel: 'Prompt (English works most reliably)',
    cost: 'About {n} characters, sent with every message (uses a little context)',
    reset: 'Restore default',
    cancel: 'Cancel',
    save: 'Save',
    saved: 'Saved; applies from your next message',
    empty: 'An empty prompt is the same as turning it off',
    settingsHint: 'Formatting hint sent to the AI: conclusion first, concise, status marked with ✅ ⚠️ ❌',
  },
};

export function at(key: Key, params: Record<string, string | number> = {}): string {
  const text = (dictionaries[getLocale()] ?? zhCN)[key] ?? zhCN[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
}
