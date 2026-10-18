/**
 * 服务器系统图标（网页版 os-icons.ts 的品牌 SVG）：桌面侧栏、桌面服务器表格、手机节点页共用。
 * 每种系统只解析一次，之后克隆。
 */
import { osIconSvg } from '../../upstream/frontend/src/os-icons';

const cache = new Map<string, SVGElement | null>();

export function osIcon(os: string | null | undefined): SVGElement | null {
  if (!os) return null;
  if (!cache.has(os)) {
    const markup = osIconSvg(os);
    const svg = markup ? new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement : null;
    cache.set(os, svg instanceof SVGElement ? svg : null);
  }
  const cached = cache.get(os);
  return cached ? (cached.cloneNode(true) as SVGElement) : null;
}
