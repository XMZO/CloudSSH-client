/**
 * 入口网关状态（标题栏实例名后面）：实例地址是 tools/gateway 的入口网关时，显示两个号今天的 Durable Object 用量、
 * 新会话放在哪边，例如“A 62% · B 3% → A”。悬停看详情（暂停原因、上次同步），点一下刷新。
 *
 * 读网关的 GET /api/__gateway/status（要登录）；普通实例没有这个接口（404），不显示、也不再问。
 * 窗口在前台时每分钟刷新一次，回到前台时也刷新。
 */
import { el } from './dom';
import { dt, onLocaleChange } from './i18n';

interface Usage {
  gbs?: number;
  ratio?: number;
  error?: string;
}

interface GatewayStatus {
  gateway: true;
  next: 'A' | 'B';
  usage: { A?: Usage; B?: Usage } | null;
  aDown: { until: number; reason: string } | null;
  mapped: { servers: number; stale: number };
  lastSync: { at: number; servers?: unknown; errors: string[] } | null;
}

const REFRESH_MS = 60_000;

const percent = (usage?: Usage): string => (usage?.ratio == null ? '?' : String(Math.round(usage.ratio * 100)));

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return dt('gwJustNow');
  if (minutes < 60) return dt('gwMinutesAgo', { n: minutes });
  return dt('gwHoursAgo', { n: Math.round(minutes / 60) });
}

function details(status: GatewayStatus): string {
  const lines = [dt('gwNext', { side: status.next })];
  for (const side of ['A', 'B'] as const) {
    const usage = status.usage?.[side];
    lines.push(
      usage?.ratio == null
        ? dt('gwUsageUnknown', { side })
        : dt('gwUsage', { side, pct: percent(usage), gbs: Math.round(usage.gbs ?? 0).toLocaleString() })
    );
  }
  if (status.aDown) {
    const time = new Date(status.aDown.until).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    lines.push(dt('gwDown', { side: 'A', time, reason: status.aDown.reason }));
  }
  if (status.mapped.stale > 0) lines.push(dt('gwStale', { count: status.mapped.stale }));
  if (status.lastSync?.at) {
    lines.push(dt('gwSync', { ago: ago(status.lastSync.at), mapped: status.mapped.servers }));
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
  const sideA = el('span', 'cs-tb-gw-side');
  const sideB = el('span', 'cs-tb-gw-side');
  button.append(sideA, el('span', 'cs-tb-gw-dot', '·'), sideB);
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
    sideA.textContent = `A ${percent(status.usage?.A)}%`;
    sideB.textContent = `B ${percent(status.usage?.B)}%`;
    sideA.classList.toggle('is-next', status.next === 'A');
    sideB.classList.toggle('is-next', status.next === 'B');
    sideA.classList.toggle('is-down', !!status.aDown);
    button.title = details(status);
    button.setAttribute('aria-label', `${dt('gwLabel')}：${dt('gwNext', { side: status.next })}`);
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
    const body = response.ok ? ((await response.json().catch(() => null)) as Partial<GatewayStatus> | null) : null;
    status = body?.gateway === true ? (body as GatewayStatus) : null;
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
