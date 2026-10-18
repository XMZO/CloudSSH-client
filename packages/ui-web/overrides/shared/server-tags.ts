/**
 * 服务器标签（侧栏、节点页里的“分组”）的增强，桌面与手机共用，不改 Worker：
 * - 添加 / 编辑服务器时，标签输入框下面列出已有标签，点一下加入、再点一下去掉（仍可手动输入新标签）
 * - 重命名标签：对带这个标签的每台服务器发一次只含 tags 的 PUT（Worker 的更新接口支持只改部分字段），
 *   改成已有的名字时两个标签合并
 * - 复制标签名
 */
import { getLocale } from '../../upstream/frontend/src/i18n';
import { copyTextToClipboard } from '../../upstream/frontend/src/clipboard';
import { normalizeTagsInput } from '../../upstream/frontend/src/server-list';
import { notify, requestText } from '../../upstream/frontend/src/ui-feedback';
import { refreshServerList } from '../sidebar/hooks';
import { getServers, subscribe } from '../sidebar/store';
import './server-tags.css';

const zhCN = {
  pickerLabel: '已有标签（点选）',
  renameTitle: '重命名标签',
  renameMessage: '“{tag}”下的 {n} 台服务器都会改用新名字；改成已有的标签名时两个标签合并。',
  renameLabel: '新名字',
  renameConfirm: '重命名',
  cancel: '取消',
  renameEmpty: '名字不能为空',
  renameComma: '名字里不能有逗号',
  renaming: '正在更新 {n} 台服务器…',
  renamed: '已重命名为“{tag}”',
  renameFailed: '有 {n} 台服务器没改成功：{error}',
  copied: '已复制“{tag}”',
};
type Key = keyof typeof zhCN;
const dictionaries: Record<string, Partial<Record<Key, string>>> = {
  'zh-TW': {
    pickerLabel: '已有標籤（點選）',
    renameTitle: '重新命名標籤',
    renameMessage: '「{tag}」下的 {n} 台伺服器都會改用新名稱；改成已有的標籤名時兩個標籤合併。',
    renameLabel: '新名稱',
    renameConfirm: '重新命名',
    renameEmpty: '名稱不能為空',
    renameComma: '名稱裡不能有逗號',
    renaming: '正在更新 {n} 台伺服器…',
    renamed: '已重新命名為「{tag}」',
    renameFailed: '有 {n} 台伺服器沒有改成功：{error}',
    copied: '已複製「{tag}」',
  },
  'en-US': {
    pickerLabel: 'Existing tags (tap to add)',
    renameTitle: 'Rename tag',
    renameMessage: 'All {n} servers tagged “{tag}” will use the new name. Renaming to an existing tag merges the two.',
    renameLabel: 'New name',
    renameConfirm: 'Rename',
    cancel: 'Cancel',
    renameEmpty: 'Name cannot be empty',
    renameComma: 'Name cannot contain commas',
    renaming: 'Updating {n} servers…',
    renamed: 'Renamed to “{tag}”',
    renameFailed: '{n} servers were not updated: {error}',
    copied: 'Copied “{tag}”',
  },
};

function tt(key: Key, params: Record<string, string | number> = {}): string {
  const text = dictionaries[getLocale()]?.[key] ?? zhCN[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
}

const lower = (tag: string) => tag.toLocaleLowerCase();

/** 所有已有标签：按使用的服务器数从多到少，再按名字 */
function existingTags(): string[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const server of getServers() ?? []) {
    for (const tag of server.tags ?? []) {
      const entry = counts.get(lower(tag)) ?? { tag, count: 0 };
      entry.count++;
      counts.set(lower(tag), entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).map((e) => e.tag);
}

// ---------- 添加 / 编辑服务器：已有标签点选 ----------

export function installTagPicker(): void {
  const input = document.getElementById('server-tags') as HTMLInputElement | null;
  if (!input) return;
  const box = document.createElement('div');
  box.className = 'cs-tag-picker';
  const label = document.createElement('div');
  label.className = 'cs-tag-picker-label';
  const chips = document.createElement('div');
  chips.className = 'cs-tag-picker-chips';
  box.append(label, chips);
  // 放在“使用逗号分隔，最多 10 个标签”提示的下面
  const hint = input.nextElementSibling;
  (hint && hint.parentElement === input.parentElement ? hint : input).after(box);

  const render = () => {
    const all = existingTags();
    box.hidden = all.length === 0;
    if (!all.length) return;
    label.textContent = tt('pickerLabel');
    const chosen = new Set(normalizeTagsInput(input.value).map(lower));
    chips.replaceChildren(
      ...all.map((tag) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'cs-tag-chip';
        chip.textContent = tag;
        const on = chosen.has(lower(tag));
        chip.classList.toggle('is-on', on);
        chip.setAttribute('aria-pressed', String(on));
        return chip;
      })
    );
  };

  // 点选时不让输入框失焦（手机上会收起键盘）
  chips.addEventListener('pointerdown', (event) => {
    if ((event.target as Element).closest('.cs-tag-chip')) event.preventDefault();
  });
  chips.addEventListener('click', (event) => {
    const chip = (event.target as Element).closest<HTMLElement>('.cs-tag-chip');
    if (!chip?.textContent) return;
    const tag = chip.textContent;
    const current = normalizeTagsInput(input.value);
    const index = current.findIndex((t) => lower(t) === lower(tag));
    if (index >= 0) current.splice(index, 1);
    else if (current.length < 10) current.push(tag);
    input.value = current.join(', ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    render();
  });
  input.addEventListener('input', render);
  subscribe(render);
  // 网页版打开对话框时直接给输入框赋值（不触发 input 事件）：对话框显示出来时再画一次
  const modal = document.getElementById('server-modal');
  if (modal) new MutationObserver(render).observe(modal, { attributes: true, attributeFilter: ['class'] });
  render();
}

// ---------- 重命名、复制 ----------

let renaming = false;

/** 重命名标签；返回是否改了 */
export async function renameTag(tag: string): Promise<boolean> {
  if (renaming) return false;
  const servers = (getServers() ?? []).filter((s) => (s.tags ?? []).some((t) => lower(t) === lower(tag)));
  if (!servers.length) return false;
  const next = await requestText({
    title: tt('renameTitle'),
    message: tt('renameMessage', { tag, n: servers.length }),
    label: tt('renameLabel'),
    defaultValue: tag,
    confirmText: tt('renameConfirm'),
    cancelText: tt('cancel'),
    maxLength: 24,
    validate: (value) => (!value.trim() ? tt('renameEmpty') : /[,，]/.test(value) ? tt('renameComma') : null),
  });
  const name = next?.trim().replace(/\s+/g, ' ');
  if (!name || name === tag) return false;

  renaming = true;
  notify(tt('renaming', { n: servers.length }), { variant: 'info', duration: 1500 });
  let failed = 0;
  let lastError = '';
  try {
    for (const server of servers) {
      // 原位替换（保持标签顺序）；新名字已在这台服务器上时去重
      const tags = normalizeTagsInput((server.tags ?? []).map((t) => (lower(t) === lower(tag) ? name : t)).join(','));
      try {
        const response = await fetch(`/api/servers/${server.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ tags }),
        });
        if (!response.ok) {
          failed++;
          lastError = ((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${response.status}`;
        }
      } catch (error) {
        failed++;
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    await refreshServerList().catch(() => undefined);
  } finally {
    renaming = false;
  }
  if (failed) notify(tt('renameFailed', { n: failed, error: lastError }), { variant: 'danger' });
  else notify(tt('renamed', { tag: name }), { variant: 'success', duration: 2000 });
  // 侧栏、节点页按标签名记住的折叠状态与排序跟着改名
  if (failed < servers.length) window.dispatchEvent(new CustomEvent<TagRenamed>(TAG_RENAMED_EVENT, { detail: { from: tag, to: name } }));
  return failed < servers.length;
}

export const TAG_RENAMED_EVENT = 'cloudssh:tag-renamed';
export interface TagRenamed {
  from: string;
  to: string;
}

export async function copyTagName(tag: string): Promise<void> {
  if (await copyTextToClipboard(tag)) notify(tt('copied', { tag }), { variant: 'success', duration: 1500 });
}
