/**
 * 液态玻璃：浮在内容上的控件做成玻璃质感，样式全部在 glass.css。
 *
 * 以前还给节点页底部栏和“回到终端”胶囊做了“边缘折射”（按尺寸生成位移贴图 + SVG feDisplacementMap 滤镜）。
 * 列表在它们下面滚动时每一帧都要重算滤镜，手机上是掉帧的主要来源之一，已去掉；磨砂、高光、描边保留。
 * 不支持 backdrop-filter 的环境里只保留半透明底色（glass.css 自动退化）。
 */
import type { SkinModule } from '../types';
import './glass.css';

export const glassModule: SkinModule = {
  id: 'glass',
  mount() {
    return () => {};
  },
};
