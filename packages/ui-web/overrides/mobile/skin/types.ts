import type { ModuleId } from './state';

/**
 * 布局模块：黑曜主题由若干可独立开关的模块组成。
 * mount() 只在主题为黑曜且模块开启时调用，返回的函数负责彻底撤销（移除插入的元素、监听与全局标记），
 * 模块的样式写在同名 .css 里，并以 html[data-cs-mods~="<id>"] 门控，卸载后自动失效。
 */
export interface SkinModule {
  id: ModuleId;
  mount(): () => void;
}
