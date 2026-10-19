/** AI 回复风格的界面文案，跟随网页版当前语言 */
import { getLocale } from '../../../upstream/frontend/src/i18n';

const zhCN = {
  button: 'AI 回复风格',
  title: 'AI 回复风格',
  intro: '把下面这段提示随消息发给 AI（对话里不显示），让回复结论在前、篇幅随问题、适合窄面板，用“正常 / 注意 / 异常”标出状态（配合配色更好读），并说明依据与改动。只保存在这台设备上。',
  enabled: '附加回复风格提示',
  promptLabel: '提示内容（建议用英文，模型理解最稳定）',
  cost: '约 {n} 个字符：每个对话开头带一次完整内容，之后每条只附一句提醒',
  reset: '恢复默认',
  cancel: '取消',
  save: '保存',
  saved: '已保存，下一条消息开始生效',
  empty: '提示内容为空时等同于关闭',
  settingsHint: '附加给 AI 的回复格式提示：结论在前、篇幅随问题、用“正常 / 注意 / 异常”标状态',
  recovered: '上下文过长，已整理前面的对话要点，在新会话中继续',
  recoveredEdit: '更早的上下文已被压缩，已带上前面的对话要点在新会话中重新发送',
};

type Key = keyof typeof zhCN;

const dictionaries: Record<string, Record<Key, string>> = {
  'zh-CN': zhCN,
  'zh-TW': {
    button: 'AI 回覆風格',
    title: 'AI 回覆風格',
    intro: '把下面這段提示隨訊息傳給 AI（對話裡不顯示），讓回覆結論在前、篇幅隨問題、適合窄面板，用「正常 / 注意 / 異常」標出狀態（搭配配色更好讀），並說明依據與改動。只儲存在這台裝置上。',
    enabled: '附加回覆風格提示',
    promptLabel: '提示內容（建議用英文，模型理解最穩定）',
    cost: '約 {n} 個字元：每個對話開頭帶一次完整內容，之後每則只附一句提醒',
    reset: '恢復預設',
    cancel: '取消',
    save: '儲存',
    saved: '已儲存，下一則訊息開始生效',
    empty: '提示內容為空時等同於關閉',
    settingsHint: '附加給 AI 的回覆格式提示：結論在前、篇幅隨問題、用「正常 / 注意 / 異常」標狀態',
    recovered: '上下文過長，已整理前面的對話重點，在新會話中繼續',
    recoveredEdit: '更早的上下文已被壓縮，已帶上前面的對話重點在新會話中重新傳送',
  },
  'en-US': {
    button: 'AI reply style',
    title: 'AI reply style',
    intro: 'This prompt is sent to the AI with your messages (it is not shown in the chat) so replies lead with the conclusion, fit the question and the narrow panel, mark status as OK / Warning / Problem (which the panel colors), and explain their basis and changes. Stored on this device only.',
    enabled: 'Append the reply style prompt',
    promptLabel: 'Prompt (English works most reliably)',
    cost: 'About {n} characters: sent in full once per conversation, then only a one-line reminder',
    reset: 'Restore default',
    cancel: 'Cancel',
    save: 'Save',
    saved: 'Saved; applies from your next message',
    empty: 'An empty prompt is the same as turning it off',
    settingsHint: 'Formatting hint sent to the AI: conclusion first, length fits the question, status as OK / Warning / Problem',
    recovered: 'The context got too long; continuing in a fresh session with a recap of the conversation',
    recoveredEdit: 'Earlier context was compacted; resent in a fresh session with a recap of the messages above',
  },
};

export function at(key: Key, params: Record<string, string | number> = {}): string {
  const text = (dictionaries[getLocale()] ?? zhCN)[key] ?? zhCN[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
}
