/**
 * 黑曜界面主题（手机端）：与网页版配色主题相互独立、可整体重写布局的界面主题。
 *
 *   state.ts         持久化状态与 html 属性（early.ts 在网页版之前调用）
 *   palette-data.ts  配色唯一来源（界面变量 + 终端调色板）
 *   palette.ts       运行时套用 / 恢复经典配色
 *   engine.ts        按状态挂载、卸载布局模块
 *   modules/         各布局模块（每个模块一个 .ts + .css，可单独开关）
 *   settings-section.ts  设置页里的“界面主题”分区
 */
import './obsidian.css';

export { startSkin } from './engine';
export { skinSettingsSection } from './settings-section';
