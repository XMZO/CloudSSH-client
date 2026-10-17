/**
 * 液态玻璃：浮在内容上的控件做成玻璃质感，样式在 glass.css。
 *
 * 这里负责“边缘折射”：给节点页底部栏和“回到终端”胶囊各生成一张位移贴图（按元素实际尺寸与圆角，
 * 越靠近边缘越把背后的内容往里折），通过 SVG 滤镜作用在玻璃层上，透过玻璃看到的列表在边缘处会弯折，
 * 接近 iOS 26 的 Liquid Glass。只用在这两个小面积控件上，大面板只做磨砂，控制开销。
 * 不支持 backdrop-filter 的环境里只保留半透明底色（glass.css 自动退化）。
 */
import { Disposer } from '../dom';
import type { SkinModule } from '../types';
import './glass.css';

const SVG_NS = 'http://www.w3.org/2000/svg';

interface LensTarget {
  selector: string;
  id: string;
  /** 折射带宽度（像素） */
  bevel: number;
  /** 位移强度（像素） */
  scale: number;
}

const LENS_TARGETS: LensTarget[] = [
  { selector: '#cs-mobile-nodes .cs-m-nodes-bar', id: 'cs-glass-lens-bar', bevel: 20, scale: 44 },
  { selector: '#cs-mobile-nodes .cs-m-banner', id: 'cs-glass-lens-pill', bevel: 14, scale: 30 },
];

function supportsLens(): boolean {
  return typeof CSS !== 'undefined' && CSS.supports('backdrop-filter', 'blur(1px)') && CSS.supports('filter', 'url(#x)');
}

/**
 * 生成圆角矩形的位移贴图：R/G 通道 128 表示不位移；靠近边缘时沿“指向内部”的法线方向偏移，
 * feDisplacementMap 据此从更靠里的位置取样，看起来就是边缘把背后的内容折进来。
 */
function lensMap(width: number, height: number, radius: number, bevel: number): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const r = Math.min(radius, w / 2, h / 2);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const image = context.createImageData(w, h);
  const data = image.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const cx = Math.min(Math.max(px, r), w - r);
      const cy = Math.min(Math.max(py, r), h - r);
      const vx = px - cx;
      const vy = py - cy;
      const length = Math.hypot(vx, vy);
      let distance: number;
      let nx = 0;
      let ny = 0;
      if (length > 0) {
        distance = r - length;
        nx = -vx / length;
        ny = -vy / length;
      } else {
        const left = px;
        const right = w - px;
        const top = py;
        const bottom = h - py;
        distance = Math.min(left, right, top, bottom);
        if (distance === left) nx = 1;
        else if (distance === right) nx = -1;
        else if (distance === top) ny = 1;
        else ny = -1;
      }
      let strength = 0;
      if (distance > 0 && distance < bevel) {
        const t = 1 - distance / bevel;
        strength = t * t * (3 - 2 * t);
      }
      const offset = (y * w + x) * 4;
      data[offset] = Math.round(128 + 127 * strength * nx);
      data[offset + 1] = Math.round(128 + 127 * strength * ny);
      data[offset + 2] = 128;
      data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

export const glassModule: SkinModule = {
  id: 'glass',
  mount() {
    const disposer = new Disposer();
    if (!supportsLens()) return () => disposer.run();

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.style.pointerEvents = 'none';
    const defs = document.createElementNS(SVG_NS, 'defs');
    svg.append(defs);
    document.body.append(svg);
    disposer.add(() => svg.remove());

    for (const target of LENS_TARGETS) {
      const element = document.querySelector<HTMLElement>(target.selector);
      if (!element) continue;
      const filter = document.createElementNS(SVG_NS, 'filter');
      filter.id = target.id;
      filter.setAttribute('filterUnits', 'userSpaceOnUse');
      filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
      filter.setAttribute('color-interpolation-filters', 'sRGB');
      const map = document.createElementNS(SVG_NS, 'feImage');
      map.setAttribute('result', 'map');
      map.setAttribute('preserveAspectRatio', 'none');
      const displace = document.createElementNS(SVG_NS, 'feDisplacementMap');
      displace.setAttribute('in', 'SourceGraphic');
      displace.setAttribute('in2', 'map');
      displace.setAttribute('scale', String(target.scale));
      displace.setAttribute('xChannelSelector', 'R');
      displace.setAttribute('yChannelSelector', 'G');
      filter.append(map, displace);
      defs.append(filter);

      let lastKey = '';
      const update = () => {
        const width = element.offsetWidth;
        const height = element.offsetHeight;
        if (!width || !height) return;
        const radius = Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
        const key = `${width}x${height}r${radius}`;
        if (key === lastKey) return;
        lastKey = key;
        for (const node of [filter, map]) {
          node.setAttribute('x', '0');
          node.setAttribute('y', '0');
          node.setAttribute('width', String(width));
          node.setAttribute('height', String(height));
        }
        map.setAttribute('href', lensMap(width, height, radius, target.bevel));
      };
      update();
      const observer = new ResizeObserver(update);
      observer.observe(element);
      disposer.add(() => observer.disconnect());
      element.style.setProperty('--cs-glass-lens', `url(#${target.id})`);
      disposer.add(() => element.style.removeProperty('--cs-glass-lens'));
    }

    return () => disposer.run();
  },
};
