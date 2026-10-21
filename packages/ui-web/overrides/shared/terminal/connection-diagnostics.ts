/** 连接元数据专用通道；绝不传递终端内容、完整 URL 或服务端消息正文。 */
interface ConnectionTerminal {
  ws?: WebSocket | null;
  sessionReady?: boolean;
  activeSessionId?: string | null;
  activeResumeToken?: string | null;
  wsLatency?: number | null;
  cfLatency?: number | null;
  reconnectAttempts?: number;
  lastHostInfo?: { serverId?: number } | null;
}
interface State {
  terminalId: number;
  connectionId: number;
  started: number;
  lastMessage: number;
  lastPong: number;
  lastSummary: number;
  receivedMessages: number;
  receivedBytes: number;
  opened: boolean;
  serverId?: number;
  serverEvent?: string;
}
const states = new WeakMap<ConnectionTerminal, State>();
let sequence = 0;
let connections = 0;

function bridge() {
  return (globalThis as typeof globalThis & {
    cloudsshDesktop?: { connectionLog?: (entry: unknown) => void };
  }).cloudsshDesktop;
}

function emit(entry: Record<string, unknown>): void {
  try {
    bridge()?.connectionLog?.({ online: navigator.onLine, visibility: document.visibilityState, ...entry });
  } catch { /* 日志通道不可用时不影响终端。 */ }
}

export function connectionDiagnostic(term: ConnectionTerminal, event: string, details: Record<string, unknown> = {}): void {
  if (!bridge()?.connectionLog) return;
  let state = states.get(term);
  const now = performance.now();
  if (!state) {
    state = { terminalId: ++sequence, connectionId: 0, started: now, lastMessage: 0, lastPong: 0,
      lastSummary: 0, receivedMessages: 0, receivedBytes: 0, opened: false };
    states.set(term, state);
  }
  if (event === 'socket-attached' && term.ws) {
    const socket = term.ws;
    state = { ...state, connectionId: ++connections, started: now, lastMessage: 0, lastPong: 0,
      lastSummary: 0, receivedMessages: 0, receivedBytes: 0, opened: socket.readyState === WebSocket.OPEN,
      serverId: term.lastHostInfo?.serverId, serverEvent: undefined };
    states.set(term, state);
    const current = state;
    // 保留旧连接的编号，避免迟到的 close/error 被记到新连接上。
    const socketEvent = (kind: string, extra: Record<string, unknown> = {}) => emit({
      event: kind, terminalId: current.terminalId, connectionId: current.connectionId,
      serverId: current.serverId, serverEvent: current.serverEvent,
      ageMs: Math.round(performance.now() - current.started), current: socket === term.ws,
      opened: current.opened, readyState: socket.readyState,
      sessionReady: socket === term.ws ? !!term.sessionReady : undefined,
      resumable: socket === term.ws ? !!(term.activeSessionId && term.activeResumeToken) : undefined,
      receivedMessages: current.receivedMessages, receivedBytes: current.receivedBytes,
      lastMessageAgoMs: current.lastMessage ? Math.round(performance.now() - current.lastMessage) : -1,
      lastPongAgoMs: current.lastPong ? Math.round(performance.now() - current.lastPong) : -1,
      ...extra,
    });
    socket.addEventListener('open', () => { current.opened = true; socketEvent('socket-open'); }, { once: true });
    socket.addEventListener('error', () => socketEvent('socket-error'));
    socket.addEventListener('close', (e) => socketEvent('socket-close', {
      code: e.code, wasClean: e.wasClean, reasonLength: e.reason.length,
      // reason 可能包含令牌或服务器输出，只记录是否存在和长度。
    }), { once: true });
    socket.addEventListener('message', (e) => {
      current.lastMessage = performance.now();
      current.receivedMessages++;
      // 字符串按长度计（Worker 发的是以 ASCII 为主的 JSON，近似字节数）：每条终端输出都在这里过，不为计数再编码复制一遍
      current.receivedBytes += typeof e.data === 'string' ? e.data.length
        : e.data instanceof Blob ? e.data.size : e.data instanceof ArrayBuffer ? e.data.byteLength : 0;
    });
  }
  if (event === 'server-event' && typeof details.serverEvent === 'string') state.serverEvent = details.serverEvent;
  if (event === 'heartbeat-summary') {
    state.lastPong = now;
    if (state.lastSummary && now - state.lastSummary < 60_000) return;
    state.lastSummary = now;
  }
  emit({ event, terminalId: state.terminalId, connectionId: state.connectionId,
    serverId: state.serverId, serverEvent: state.serverEvent,
    ageMs: Math.round(now - state.started), readyState: term.ws?.readyState,
    sessionReady: !!term.sessionReady, resumable: !!(term.activeSessionId && term.activeResumeToken),
    attempt: term.reconnectAttempts, wsLatency: term.wsLatency, cfLatency: term.cfLatency,
    receivedMessages: state.receivedMessages, receivedBytes: state.receivedBytes,
    lastMessageAgoMs: state.lastMessage ? Math.round(now - state.lastMessage) : -1,
    lastPongAgoMs: state.lastPong ? Math.round(now - state.lastPong) : -1,
    ...details });
}

let installed = false;
export function installConnectionDiagnostics(): void {
  if (installed || !bridge()?.connectionLog) return;
  installed = true;
  (globalThis as { __cloudsshConnectionDiagnostic?: typeof connectionDiagnostic }).__cloudsshConnectionDiagnostic = connectionDiagnostic;
  for (const event of ['online', 'offline']) window.addEventListener(event, () => emit({ event }));
  document.addEventListener('visibilitychange', () => emit({ event: 'visibility' }));
  window.addEventListener('pagehide', () => emit({ event: 'page-hide' }));
  emit({ event: 'page-ready' });
}
