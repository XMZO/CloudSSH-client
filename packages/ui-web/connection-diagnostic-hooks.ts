/** 插入诊断调用，保持 upstream 原文件不变。每个锚点都有源码级测试。 */
export const CONNECTION_DIAGNOSTIC_HOOKS = [
  {
    anchor: '  private setupWebSocketHandlers(rejectFn?: (reason?: any) => void): void {\n    if (!this.ws) return;\n    const socket = this.ws;\n',
    inject: "    (globalThis as any).__cloudsshConnectionDiagnostic?.(this, 'socket-attached');\n",
  },
  {
    anchor: "          switch (msg.type) {\n            case 'status':\n",
    inject: "              (globalThis as any).__cloudsshConnectionDiagnostic?.(this, 'server-event', { messageType: msg.type, serverEvent: msg.event });\n",
  },
  {
    anchor: "            case 'error':\n",
    inject: "              (globalThis as any).__cloudsshConnectionDiagnostic?.(this, 'server-event', { messageType: msg.type, serverEvent: msg.event });\n",
  },
  {
    anchor: '            this.shareResumeSupported = msg.resumeEnabled !== false;\n',
    inject: "            (globalThis as any).__cloudsshConnectionDiagnostic?.(this, 'session-created');\n",
  },
  {
    anchor: "            this.onSessionReady?.();\n            this.startHeartbeat();\n",
    inject: "            (globalThis as any).__cloudsshConnectionDiagnostic?.(this, 'session-resumed');\n",
  },
  {
    anchor: '    this.wsLatency = Math.round(performance.now() - this.lastPingTime);\n',
    inject: "    (globalThis as any).__cloudsshConnectionDiagnostic?.(this, 'heartbeat-summary');\n",
  },
  {
    anchor: '  private recoverUnresponsiveConnection(socket: WebSocket): void {\n    if (socket !== this.ws) return;\n',
    inject: "    (globalThis as any).__cloudsshConnectionDiagnostic?.(this, 'heartbeat-timeout');\n",
  },
  {
    anchor: '  private resetActiveConnection(): void {\n',
    inject: "    if (this.ws) (globalThis as any).__cloudsshConnectionDiagnostic?.(this, 'socket-reset');\n",
  },
  {
    anchor: '    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);\n',
    inject: "    (globalThis as any).__cloudsshConnectionDiagnostic?.(this, 'reconnect-scheduled', { delayMs: delay, cause: 'new-session' });\n",
  },
].map((hook) => ({ file: '/upstream/frontend/src/terminal.ts', ...hook }));
