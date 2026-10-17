/**
 * 按键栏：网页版移动端快捷键栏的外观（更大的圆角按键、按下反馈、Ctrl/Alt 锁定态高亮）。
 * 按键内容与行为仍由网页版（含“自定义快捷键”）生成，这里只有样式，见 dock.css。
 */
import type { SkinModule } from '../types';
import './dock.css';

export const dockModule: SkinModule = {
  id: 'dock',
  mount() {
    return () => {};
  },
};
