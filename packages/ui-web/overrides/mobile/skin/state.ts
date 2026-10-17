/**
 * 界面主题的持久化状态。
 *
 * early.ts 在网页版任何脚本之前就会读取并写入 html 属性（避免启动时先闪一下旧界面），
 * 所以这个文件保持零依赖：不引入 i18n、不碰网页版模块。
 *
 * html 属性约定（CSS 全部据此门控，经典主题下不产生任何影响）：
 *   data-cs-skin="obsidian"            启用黑曜主题
 *   data-cs-accent="indigo|teal|…"     强调色
 *   data-cs-mods="hosts chrome …"      已开启的布局模块（CSS 用 ~= 匹配）
 */

export const SKIN_STORAGE_KEY = 'cloudssh_mobile_skin';

export const SKIN_IDS = ['obsidian', 'classic'] as const;
export type SkinId = (typeof SKIN_IDS)[number];

export const ACCENT_IDS = ['indigo', 'teal', 'green', 'amber', 'rose'] as const;
export type AccentId = (typeof ACCENT_IDS)[number];

/** 布局模块（顺序即设置页里的显示顺序）。新增模块：在这里加 id，再在 modules/index.ts 注册实现 */
export const MODULE_IDS = ['hosts', 'chrome', 'sheets', 'commands', 'dock', 'motion'] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/** 终端字号：0 表示自动（跟随网页版的屏幕宽度规则） */
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 18;

export interface SkinState {
  skin: SkinId;
  accent: AccentId;
  modules: Record<ModuleId, boolean>;
  fontSize: number;
}

export function defaultSkinState(): SkinState {
  return {
    skin: 'obsidian',
    accent: 'indigo',
    modules: Object.fromEntries(MODULE_IDS.map((id) => [id, true])) as Record<ModuleId, boolean>,
    fontSize: 0,
  };
}

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/** 读取并校验；字段缺失或非法时用默认值补齐（新增模块默认开启） */
export function loadSkinState(): SkinState {
  const state = defaultSkinState();
  try {
    const raw = JSON.parse(localStorage.getItem(SKIN_STORAGE_KEY) ?? 'null') as Partial<SkinState> | null;
    if (!raw || typeof raw !== 'object') return state;
    if (isOneOf(SKIN_IDS, raw.skin)) state.skin = raw.skin;
    if (isOneOf(ACCENT_IDS, raw.accent)) state.accent = raw.accent;
    if (raw.modules && typeof raw.modules === 'object') {
      for (const id of MODULE_IDS) {
        const value = (raw.modules as Record<string, unknown>)[id];
        if (typeof value === 'boolean') state.modules[id] = value;
      }
    }
    const size = Number(raw.fontSize);
    if (Number.isInteger(size) && size >= FONT_SIZE_MIN && size <= FONT_SIZE_MAX) state.fontSize = size;
  } catch {
    // 存储不可用或内容损坏：用默认值
  }
  return state;
}

export function saveSkinState(state: SkinState): void {
  try {
    localStorage.setItem(SKIN_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用时只是不记忆
  }
}

export function enabledModules(state: SkinState): ModuleId[] {
  return state.skin === 'obsidian' ? MODULE_IDS.filter((id) => state.modules[id]) : [];
}

export function applySkinAttributes(state: SkinState): void {
  const root = document.documentElement;
  if (state.skin === 'obsidian') {
    root.dataset.csSkin = 'obsidian';
    root.dataset.csAccent = state.accent;
    root.dataset.csMods = enabledModules(state).join(' ');
  } else {
    delete root.dataset.csSkin;
    delete root.dataset.csAccent;
    delete root.dataset.csMods;
  }
}
