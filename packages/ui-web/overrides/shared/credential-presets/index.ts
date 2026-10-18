/**
 * 凭据预设（桌面端与手机端共用）：
 *   store.ts    本机加密保存、写进服务器（PUT /api/servers/:id）
 *   form.ts     “添加 / 编辑服务器”对话框里的预设选择、存为预设
 *   manager.ts  预设管理：新建、编辑、删除、选服务器批量写入、同步
 * 平台启动时调用 installCredentialPresets，指定加密方式（桌面 safeStorage、手机 Keystore）与实例标识。
 */
import { installPresetPicker } from './form';
import { configurePresets, type PresetVault } from './store';

export { openPresetManager, isPresetManagerOpen, closePresetManager } from './manager';
export { configurePresets, localVault, type PresetVault } from './store';
export { pt as presetText } from './i18n';

export function installCredentialPresets(options: { vault?: PresetVault | null; scope?: string | null } = {}): void {
  configurePresets(options);
  installPresetPicker();
}
