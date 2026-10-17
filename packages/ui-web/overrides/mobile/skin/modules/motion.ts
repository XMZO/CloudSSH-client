/**
 * 流畅动画：页面切换、终端栏进场、按压反馈（motion.css），以及其他模块里按此开关决定的过渡
 * （面板滑入滑出、会话切换的滑动）。系统开启“减少动态效果”时一律关闭。
 */
import type { SkinModule } from '../types';
import './motion.css';

export const motionModule: SkinModule = {
  id: 'motion',
  mount() {
    return () => {};
  },
};
