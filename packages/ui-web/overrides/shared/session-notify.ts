/**
 * 后台提醒：人不在窗口前（窗口不在前台 / 应用切到后台）时，用系统通知说一声——
 *   - 长命令结束：回车后过了 10 秒以上才回到 Shell 提示符（vim、top 这类全屏程序里不算）
 *   - 终端响铃（\a），以及程序主动发的通知（OSC 9、OSC 777;notify，例如 printf '\e]9;构建完成\a'）
 *   - 会话断开（连着的会话掉线超过 3 秒），以及断线后重新连上
 * 点通知回到对应的会话标签。人在窗口前、但长命令结束在别的标签里时，只在页面上提示一下。
 * 设置里有总开关，以及三个分项（长命令完成、响铃与程序通知、断线与重连），分项默认都开。
 *
 * “回到提示符”的判断：有输出、随后安静了一会儿，且光标所在行的光标左边以 $ # % > ❯ » 之一（加空格）结尾。
 * 不依赖 Shell 集成脚本，所以偶尔会漏（自定义了奇特的提示符）或多报（程序输出恰好以这些字符结尾后停住）。
 * 通知怎么发由平台决定：桌面用网页的 Notification（Electron 转成系统通知），手机走原生插件。
 */
import type { IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { getLocale } from '../../upstream/frontend/src/i18n';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import { activeTabId, listTabs, sessionIsConnected, terminalVisible, type TabInfo } from '../sidebar/hooks';

export interface SessionNotice {
  title: string;
  body: string;
  /** 点通知后切到的标签 */
  tabId: string;
}

export interface NoticeSink {
  /** 人不在窗口前：只有这时才发系统通知 */
  away(): boolean;
  show(notice: SessionNotice): void;
}

const PREF_KEY = 'cloudssh_notifications';
const LONG_COMMAND_MS = 10_000;
const QUIET_MS = 800;
const DOWN_GRACE_MS = 3_000;
const POLL_MS = 1_000;
const PROMPT_END = /[$#%>❯»]\s?$/;

const texts = {
  'zh-CN': {
    done: '命令已完成：{cmd}',
    doneIn: '{name} · 用时 {time}',
    bell: '终端响铃',
    message: '{name} 的通知',
    down: '会话已断开',
    downRetry: '{name} · 正在自动重连',
    up: '已重新连接',
    inTab: '{name}：命令已完成（{time}）',
    kindCommand: '长命令完成',
    kindCommandHint: '回车后超过 10 秒才回到提示符',
    kindBell: '响铃与程序通知',
    kindBellHint: '终端响铃，以及程序用 OSC 9 / 777 发的通知',
    kindConnection: '断线与重连',
    kindConnectionHint: '会话断开超过 3 秒，以及之后重新连上',
    kindCommandShort: '长命令完成',
    kindBellShort: '响铃与提醒',
    kindConnectionShort: '断线与重连',
  },
  'zh-TW': {
    done: '指令已完成：{cmd}',
    doneIn: '{name} · 耗時 {time}',
    bell: '終端機響鈴',
    message: '{name} 的通知',
    down: '工作階段已中斷',
    downRetry: '{name} · 正在自動重新連線',
    up: '已重新連線',
    inTab: '{name}：指令已完成（{time}）',
    kindCommand: '長指令完成',
    kindCommandHint: '按 Enter 後超過 10 秒才回到提示字元',
    kindBell: '響鈴與程式通知',
    kindBellHint: '終端機響鈴，以及程式用 OSC 9 / 777 發的通知',
    kindConnection: '中斷與重新連線',
    kindConnectionHint: '工作階段中斷超過 3 秒，以及之後重新連上',
    kindCommandShort: '長指令完成',
    kindBellShort: '響鈴與提醒',
    kindConnectionShort: '中斷與重連',
  },
  'en-US': {
    done: 'Command finished: {cmd}',
    doneIn: '{name} · took {time}',
    bell: 'Terminal bell',
    message: 'Message from {name}',
    down: 'Session disconnected',
    downRetry: '{name} · reconnecting',
    up: 'Reconnected',
    inTab: '{name}: command finished ({time})',
    kindCommand: 'Long commands finished',
    kindCommandHint: 'Back at the prompt more than 10 seconds after Enter',
    kindBell: 'Bells and program alerts',
    kindBellHint: 'Terminal bells and OSC 9 / 777 notifications sent by programs',
    kindConnection: 'Disconnects and reconnects',
    kindConnectionHint: 'A session drops for more than 3 seconds, and when it comes back',
    kindCommandShort: 'Long commands',
    kindBellShort: 'Bells',
    kindConnectionShort: 'Disconnects',
  },
};

function nt(key: keyof (typeof texts)['zh-CN'], params: Record<string, string> = {}): string {
  const dict = (texts as Record<string, Record<string, string>>)[getLocale()] ?? texts['zh-CN'];
  return (dict[key] ?? texts['zh-CN'][key]).replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? '');
}

export function notificationsEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setNotificationsEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, 'off');
  } catch {
    // 忽略
  }
}

/** 分项开关（默认都开）；总开关关掉时一律不发 */
export type NoticeKind = 'command' | 'bell' | 'connection';
export const NOTICE_KINDS: readonly NoticeKind[] = ['command', 'bell', 'connection'];

const KIND_KEYS: Record<NoticeKind, string> = {
  command: 'cloudssh_notify_command',
  bell: 'cloudssh_notify_bell',
  connection: 'cloudssh_notify_connection',
};

export function noticeKindEnabled(kind: NoticeKind): boolean {
  try {
    return localStorage.getItem(KIND_KEYS[kind]) !== 'off';
  } catch {
    return true;
  }
}

export function setNoticeKindEnabled(kind: NoticeKind, enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(KIND_KEYS[kind]);
    else localStorage.setItem(KIND_KEYS[kind], 'off');
  } catch {
    // 忽略
  }
}

/** 设置界面用的名称与说明；short 是电脑端设置面板里排成一行用的短名 */
export function noticeKindText(kind: NoticeKind): { title: string; hint: string; short: string } {
  const key = kind === 'command' ? 'kindCommand' : kind === 'bell' ? 'kindBell' : 'kindConnection';
  return { title: nt(key), hint: nt(`${key}Hint`), short: nt(`${key}Short`) };
}

function shouldNotify(kind: NoticeKind): boolean {
  return notificationsEnabled() && noticeKindEnabled(kind);
}

export function formatDuration(ms: number, locale = getLocale()): string {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (locale === 'en-US') {
    if (hours) return `${hours}h ${minutes}m`;
    if (minutes) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }
  const [h, m, s] = locale === 'zh-TW' ? ['小時', '分', '秒'] : ['小时', '分', '秒'];
  if (hours) return `${hours} ${h} ${minutes} ${m}`;
  if (minutes) return `${minutes} ${m} ${seconds} ${s}`;
  return `${seconds} ${s}`;
}

/** 第 row 行所在的逻辑行（含折行）；给了 endColumn 时只取到该列为止（光标左边） */
export function logicalLine(term: Terminal, row: number, endColumn?: number): string {
  const buffer = term.buffer.active;
  let text = buffer.getLine(row)?.translateToString(endColumn === undefined, 0, endColumn) ?? '';
  for (let prev = row; prev > 0 && buffer.getLine(prev)?.isWrapped; prev--) {
    text = (buffer.getLine(prev - 1)?.translateToString(false) ?? '') + text;
  }
  if (endColumn === undefined) {
    for (let next = row + 1; buffer.getLine(next)?.isWrapped; next++) text += buffer.getLine(next)?.translateToString(true) ?? '';
  }
  return text;
}

function textBeforeCursor(term: Terminal): string {
  const buffer = term.buffer.active;
  return logicalLine(term, buffer.baseY + buffer.cursorY, buffer.cursorX);
}

/** 回车时这一行里提示符后面的命令（用于通知正文）；没有命令（空回车）返回空串 */
export function commandFromLine(line: string): string {
  const trimmed = line.trimEnd();
  const match = /^.*?[$#%>❯»]\s+(.*)$/.exec(trimmed);
  return (match ? match[1] : trimmed).trim();
}

export function looksLikePrompt(textBeforeCursor: string): boolean {
  return PROMPT_END.test(textBeforeCursor) && textBeforeCursor.trim().length > 1;
}

interface Track {
  term: Terminal | null;
  disposables: IDisposable[];
  everConnected: boolean;
  downSince: number | null;
  downNotified: boolean;
  /** 回车时在那一行做的标记：命令结束时再读一遍（回车那一刻服务器的回显可能还没到齐） */
  command: { started: number; marker: IMarker | undefined; typed: string } | null;
  lastOutput: number;
}

function xtermOf(tab: TabInfo): Terminal | null {
  const term = (tab.terminal as { terminal?: Terminal } | undefined)?.terminal;
  return term && typeof term.onData === 'function' ? term : null;
}

function tabName(tab: TabInfo): string {
  return tab.label || tab.hostInfo?.host || 'CloudSSH';
}

export function installSessionNotifications(sink: NoticeSink): void {
  const tracks = new Map<string, Track>();

  const send = (kind: NoticeKind, notice: SessionNotice) => {
    if (!shouldNotify(kind)) return;
    try {
      sink.show(notice);
    } catch (error) {
      console.warn('[cloudssh] 通知发送失败', error);
    }
  };

  /** 人在窗口前，但不在看这个标签 */
  const elsewhere = (tabId: string) => !terminalVisible() || activeTabId() !== tabId;

  const attach = (tab: TabInfo, track: Track, term: Terminal) => {
    for (const item of track.disposables) item.dispose();
    track.term = term;
    track.disposables = [
      term.onData((data) => {
        if (!data.includes('\r') || term.buffer.active.type !== 'normal') return;
        track.command?.marker?.dispose();
        const buffer = term.buffer.active;
        track.command = {
          started: Date.now(),
          marker: term.registerMarker(0),
          typed: commandFromLine(logicalLine(term, buffer.baseY + buffer.cursorY)),
        };
      }),
      term.onWriteParsed(() => {
        track.lastOutput = Date.now();
      }),
      term.onBell(() => {
        if (sink.away()) send('bell', { title: nt('bell'), body: tabName(tab), tabId: tab.id });
      }),
      // OSC 9;<消息>（ConEmu / Windows Terminal 的 9;4 是进度条，不算）
      term.parser.registerOscHandler(9, (data) => {
        if (/^4;/.test(data) || !data.trim()) return false;
        if (sink.away()) send('bell', { title: nt('message', { name: tabName(tab) }), body: data.slice(0, 200), tabId: tab.id });
        return true;
      }),
      // OSC 777;notify;<标题>;<正文>（rxvt / foot / kitty）
      term.parser.registerOscHandler(777, (data) => {
        const [kind, title, ...rest] = data.split(';');
        if (kind !== 'notify') return false;
        if (sink.away()) send('bell', { title: (title || tabName(tab)).slice(0, 100), body: rest.join(';').slice(0, 200), tabId: tab.id });
        return true;
      }),
    ];
  };

  const checkCommand = (tab: TabInfo, track: Track, now: number) => {
    const { term, command } = track;
    if (!term || !command) return;
    if (track.lastOutput <= command.started || now - track.lastOutput < QUIET_MS) return;
    if (term.buffer.active.type !== 'normal' || !looksLikePrompt(textBeforeCursor(term))) return;
    track.command = null;
    const { marker } = command;
    const text = (marker && !marker.isDisposed && marker.line >= 0 ? commandFromLine(logicalLine(term, marker.line)) : '') || command.typed;
    marker?.dispose();
    const took = track.lastOutput - command.started;
    // 空回车（只有提示符）或很快结束的命令不提醒
    if (!text || took < LONG_COMMAND_MS) return;
    const time = formatDuration(took);
    const title = text.slice(0, 80);
    if (sink.away()) {
      send('command', { title: nt('done', { cmd: title }), body: nt('doneIn', { name: tabName(tab), time }), tabId: tab.id });
    } else if (elsewhere(tab.id) && shouldNotify('command')) {
      notify(nt('inTab', { name: tabName(tab), time }), { title, variant: 'success' });
    }
  };

  const checkConnection = (tab: TabInfo, track: Track, now: number) => {
    if (sessionIsConnected(tab)) {
      if (track.downNotified && sink.away()) send('connection', { title: nt('up'), body: tabName(tab), tabId: tab.id });
      track.everConnected = true;
      track.downSince = null;
      track.downNotified = false;
      return;
    }
    if (!track.everConnected) return;
    track.downSince ??= now;
    // 断线后命令状态作废（重连后是新的 Shell）
    track.command?.marker?.dispose();
    track.command = null;
    if (track.downNotified || now - track.downSince < DOWN_GRACE_MS || !sink.away()) return;
    track.downNotified = true;
    const retrying = tab.state === 'connecting';
    send('connection', { title: nt('down'), body: retrying ? nt('downRetry', { name: tabName(tab) }) : tabName(tab), tabId: tab.id });
  };

  const tick = () => {
    const now = Date.now();
    const seen = new Set<string>();
    for (const tab of listTabs()) {
      seen.add(tab.id);
      let track = tracks.get(tab.id);
      if (!track) {
        track = { term: null, disposables: [], everConnected: false, downSince: null, downNotified: false, command: null, lastOutput: 0 };
        tracks.set(tab.id, track);
      }
      // 网页版重连时可能换一个新终端对象
      const term = xtermOf(tab);
      if (term && term !== track.term) attach(tab, track, term);
      checkCommand(tab, track, now);
      checkConnection(tab, track, now);
    }
    for (const [id, track] of tracks) {
      if (seen.has(id)) continue;
      for (const item of track.disposables) item.dispose();
      tracks.delete(id);
    }
  };
  setInterval(tick, POLL_MS);
}
