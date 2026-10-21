/** 只允许诊断元数据穿过 IPC；拒绝 URL、消息正文、凭据和嵌套对象。 */
const EVENTS = new Set([
  'page-ready', 'online', 'offline', 'visibility', 'page-hide',
  'socket-attached', 'socket-open', 'socket-error', 'socket-close', 'socket-reset',
  'server-event', 'session-created', 'session-resumed', 'heartbeat-summary', 'heartbeat-timeout', 'heartbeat-postponed',
  'resume-attempt', 'resume-probe', 'resume-wait', 'resume-give-up', 'reconnect-scheduled',
]);
const NUMBERS = new Set([
  'terminalId', 'connectionId', 'serverId', 'readyState', 'code', 'ageMs', 'lastMessageAgoMs', 'lastPongAgoMs',
  'receivedMessages', 'receivedBytes', 'wsLatency', 'cfLatency', 'attempt', 'onlineFailures',
  'remainingMs', 'delayMs', 'durationMs', 'httpStatus', 'reasonLength', 'elapsedMs', 'silentMs',
]);
const BOOLEANS = new Set(['online', 'sessionReady', 'resumable', 'wasClean', 'opened', 'current', 'reachable']);
const LABELS = new Set(['visibility', 'serverEvent', 'messageType', 'cause', 'errorName']);

export function connectionLogData(input: unknown): Record<string, string | number | boolean> | null {
  if (!input || typeof input !== 'object') return null;
  const source = input as Record<string, unknown>;
  if (typeof source.event !== 'string' || !EVENTS.has(source.event)) return null;
  const result: Record<string, string | number | boolean> = { event: source.event };
  for (const key of NUMBERS) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  for (const key of BOOLEANS) if (typeof source[key] === 'boolean') result[key] = source[key];
  for (const key of LABELS) {
    const value = source[key];
    if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)) result[key] = value;
  }
  return result;
}

/** 丢弃全部查询参数和未知路径段（分享链接、恢复 token 可能在其中）。 */
export function connectionEndpoint(raw: string): { endpoint: string; resume: boolean } {
  try {
    const url = new URL(raw);
    const route = /^\/api\/(ssh|health|sftp)(\/|$)/.exec(url.pathname)?.[1];
    return { endpoint: `${url.origin}/api/${route ?? '[other]'}`, resume: url.searchParams.has('resume_token') };
  } catch { return { endpoint: '[invalid]', resume: false }; }
}

/** 一次非正常断开（code 不是 1000） */
export interface AbnormalClose { instance: string; window: number; code?: number }

/**
 * 同时断开检测：第一次非正常断开后等 windowMs，期间断开的连接数到 2 条及以上就报告一次。
 * 几条连接（多个标签、多台服务器）同一时刻一起断，说明是它们共用的那一段出了事：本机网络、系统代理 / TUN、
 * Cloudflare 边缘或 Worker 重新部署，而不是某一台服务器自己的问题。
 */
export function createCloseBurstDetector(
  report: (summary: { count: number; instances: string[]; windows: number; codes: number[]; spanMs: number }) => void,
  windowMs = 3000,
  now: () => number = Date.now,
  schedule: (run: () => void, ms: number) => unknown = setTimeout,
): (close: AbnormalClose) => void {
  let burst: { start: number; last: number; closes: AbnormalClose[] } | null = null;
  return (close) => {
    const at = now();
    if (burst) {
      burst.closes.push(close);
      burst.last = at;
      return;
    }
    const current = { start: at, last: at, closes: [close] };
    burst = current;
    schedule(() => {
      burst = null;
      if (current.closes.length < 2) return;
      report({
        count: current.closes.length,
        instances: [...new Set(current.closes.map((item) => item.instance))],
        windows: new Set(current.closes.map((item) => item.window)).size,
        codes: [...new Set(current.closes.map((item) => item.code ?? 0))],
        spanMs: current.last - current.start,
      });
    }, windowMs);
  };
}
