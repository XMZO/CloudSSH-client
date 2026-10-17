/**
 * 黑曜主题的布局模块注册表。
 * 新增模块：在 state.ts 的 MODULE_IDS 加 id，在 skin/i18n.ts 加 mod_<id> 与 mod_<id>_desc 文案，再在这里登记实现；
 * 删除模块：反过来移除即可。设置页的模块开关列表、html[data-cs-mods] 门控都会自动跟上。
 */
import type { ModuleId } from '../state';
import type { SkinModule } from '../types';
import { chromeModule } from './chrome';
import { commandsModule } from './commands';
import { dockModule } from './dock';
import { glassModule } from './glass';
import { hostsModule } from './hosts';
import { motionModule } from './motion';
import { sheetsModule } from './sheets';

export const MODULES: SkinModule[] = [hostsModule, chromeModule, sheetsModule, commandsModule, dockModule, glassModule, motionModule];

export const MODULE_BY_ID = new Map<ModuleId, SkinModule>(MODULES.map((module) => [module.id, module]));
