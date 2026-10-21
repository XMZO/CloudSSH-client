/** 只允许诊断元数据穿过 IPC；拒绝 URL、消息正文、凭据和嵌套对象。 */
const EVENTS = new Set([
  'page-ready', 'online', 'offline', 'visibility', 'page-hide',
  'socket-attached', 'socket-open', 'socket-error', 'socket-close', 'socket-reset',
  'server-event', 'session-created', 'session-resumed', 'heartbeat-summary', 'heartbeat-timeout',
  'resume-attempt', 'resume-probe', 'resume-wait', 'resume-give-up', 'reconnect-scheduled',
]);
const NUMBERS = new Set([
  'terminalId', 'connectionId', 'serverId', 'readyState', 'code', 'ageMs', 'lastMessageAgoMs', 'lastPongAgoMs',
  'receivedMessages', 'receivedBytes', 'wsLatency', 'cfLatency', 'attempt', 'onlineFailures',
  'remainingMs', 'delayMs', 'durationMs', 'httpStatus', 'reasonLength',
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
