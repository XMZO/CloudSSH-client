/**
 * 入口网关状态（标题栏实例名后面）：实例地址是 tools/gateway 的入口网关时，显示各节点今天的 Durable Object 用量、
 * 新会话放在哪个节点，例如“A 62% · B 3%”（新会话放的那个高亮，主节点带 *）。悬停看详情（暂停原因、上次同步），点一下刷新。
 *
 * 读网关的 GET /api/__gateway/status（要登录）；普通实例没有这个接口（404），不显示、也不再问。
 * 两版网关的返回都由 ../shared/gateway/model.ts 整理成同样的节点列表。
 * 窗口在前台时每分钟刷新一次，回到前台时也刷新。
 */
import { el } from './dom';
import { dt, onLocaleChange } from './i18n';
import { type GatewayStatus, mappedServers, normalizeGatewayStatus, percentText as percent } from '../shared/gateway/model';

const REFRESH_MS = 60_000;

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return dt('gwJustNow');
  if (minutes < 60) return dt('gwMinutesAgo', { n: minutes });
  return dt('gwHoursAgo', { n: Math.round(minutes / 60) });
}

function details(status: GatewayStatus): string {
  const lines = status.next ? [dt('gwNext', { side: status.next })] : [];
  const home = status.nodes.find((node) => node.home);
  if (home && status.nodes.length > 1) lines.push(dt('gwHome', { side: home.name }));
  for (const node of status.nodes) {
    lines.push(
      node.ratio == null
        ? dt('gwUsageUnknown', { side: node.name })
        : dt('gwUsage', { side: node.name, pct: percent(node.ratio), gbs: Math.round(node.gbs ?? 0).toLocaleString() })
    );
    if (node.down) {
      const time = new Date(node.down.until).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      lines.push(dt('gwDown', { side: node.name, time, reason: node.down.reason }));
    }
    if (node.mapped && node.mapped.stale > 0) lines.push(dt('gwStale', { count: node.mapped.stale, side: node.name }));
  }
  const mapped = mappedServers(status);
  if (status.lastSync) {
    lines.push(dt('gwSync', { ago: ago(status.lastSync.at), mapped }));
    if (status.lastSync.errors.length) lines.push(dt('gwSyncIssues', { count: status.lastSync.errors.length, first: status.lastSync.errors[0] }));
  } else {
    lines.push(dt('gwSyncNever'));
  }
  lines.push(dt('gwRefresh'));
  return lines.join('\n');
}

export function mountGatewayStatus(container: HTMLElement): void {
  const button = el('button', 'cs-tb-gateway');
  button.type = 'button';
  button.hidden = true;
  container.append(button);

  let status: GatewayStatus | null = null;
  let stopped = false;
  let timer = 0;

  const render = () => {
    if (!status) {
      button.hidden = true;
      return;
    }
    button.hidden = false;
    const parts: HTMLElement[] = [];
    for (const node of status.nodes) {
      if (parts.length) parts.push(el('span', 'cs-tb-gw-dot', '·'));
      const side = el('span', 'cs-tb-gw-side', `${node.name}${node.home && status.nodes.length > 1 ? '*' : ''} ${percent(node.ratio)}%`);
      side.classList.toggle('is-next', node.name === status.next);
      side.classList.toggle('is-down', !!node.down);
      parts.push(side);
    }
    button.replaceChildren(...parts);
    button.title = details(status);
    button.setAttribute('aria-label', status.next ? `${dt('gwLabel')}：${dt('gwNext', { side: status.next })}` : dt('gwLabel'));
  };

  const refresh = async () => {
    if (stopped) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), REFRESH_MS);
    if (document.visibilityState === 'hidden') return;
    let response: Response;
    try {
      response = await fetch('/api/__gateway/status', { credentials: 'include', cache: 'no-store' });
    } catch {
      return; // 网络错误：下一次再试
    }
    if (response.status === 401) return; // 还没登录：登录后下一次就有了
    // 普通实例：没有这个接口（404，或者返回的是网页），以后也不再问
    status = response.ok ? normalizeGatewayStatus(await response.json().catch(() => null)) : null;
    if (!status) {
      stopped = true;
      window.clearTimeout(timer);
    }
    render();
  };

  button.addEventListener('click', () => void refresh());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });
  onLocaleChange(render);
  void refresh();
}
