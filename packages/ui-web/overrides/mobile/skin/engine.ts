/**
 * 界面主题引擎：根据状态切换配色、挂载/卸载布局模块。
 *
 * - 切换主题、换强调色、开关模块都是即时生效：不刷新页面，SSH 会话不受影响
 * - 单个模块挂载出错只记日志，不影响其他模块和网页版本身
 * - 终端字号只在黑曜主题下覆盖（经典主题保持网页版的规则）
 */
import { MODULES } from './modules';
import { applyObsidianPalette, restoreClassicPalette } from './palette';
import { requestTerminalRefit } from './dom';
import {
  applySkinAttributes,
  defaultSkinState,
  enabledModules,
  loadSkinState,
  saveSkinState,
  type ModuleId,
  type SkinState,
} from './state';

export const SKIN_CHANGED_EVENT = 'cloudssh:skin-changed';

let state: SkinState = loadSkinState();
let started = false;
let paletteSkin: SkinState['skin'] | null = null;
const mounted = new Map<ModuleId, () => void>();

const clone = (value: SkinState): SkinState => ({ ...value, modules: { ...value.modules } });

export function skinState(): SkinState {
  return clone(state);
}

export function isModuleActive(id: ModuleId): boolean {
  return state.skin === 'obsidian' && state.modules[id];
}

/** 修改状态并立即应用 */
export function updateSkin(change: (draft: SkinState) => void): void {
  const draft = clone(state);
  change(draft);
  state = draft;
  saveSkinState(state);
  if (started) apply();
}

export function resetSkin(): void {
  const keepSkin = state.skin;
  state = defaultSkinState();
  state.skin = keepSkin;
  saveSkinState(state);
  if (started) apply();
}

/** 网页版初始化完成后调用一次 */
export function startSkin(): void {
  if (started) return;
  started = true;
  apply();
}

function setTerminalFontOverride(size: number): void {
  const scope = globalThis as { __cloudsshTerminalFontSize?: number };
  if (size > 0) scope.__cloudsshTerminalFontSize = size;
  else delete scope.__cloudsshTerminalFontSize;
}

function apply(): void {
  applySkinAttributes(state);
  const obsidian = state.skin === 'obsidian';

  try {
    if (obsidian) applyObsidianPalette(state.accent);
    else if (paletteSkin === 'obsidian') restoreClassicPalette();
  } catch (error) {
    console.error('[cloudssh] skin palette', error);
  }
  paletteSkin = state.skin;
  setTerminalFontOverride(obsidian ? state.fontSize : 0);

  const wanted = new Set(enabledModules(state));
  for (const module of MODULES) {
    const cleanup = mounted.get(module.id);
    if (wanted.has(module.id) && !cleanup) {
      try {
        mounted.set(module.id, module.mount());
      } catch (error) {
        console.error(`[cloudssh] skin module ${module.id} failed to mount`, error);
      }
    } else if (!wanted.has(module.id) && cleanup) {
      mounted.delete(module.id);
      try {
        cleanup();
      } catch (error) {
        console.error(`[cloudssh] skin module ${module.id} failed to unmount`, error);
      }
    }
  }

  window.dispatchEvent(new CustomEvent(SKIN_CHANGED_EVENT));
  requestTerminalRefit();
}
