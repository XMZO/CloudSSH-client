/**
 * 终端关键词高亮的规则：内置一套，用户可以开关、改颜色、改写、增删，也能用 JSON 导入导出。
 *
 * 规则按列表顺序生效，同一个字符只取最先匹配到的规则：结构化的内容（URL、路径、IP、时间……）排在前面，
 * 所以 /var/log/nginx/error.log 整体按路径着色，不会被中间的 error 抢走。用户新加的规则放在最前面。
 * 导入导出的格式与常见终端一致：[{ enabled, pattern, note, color, flags? }]，flags 缺省为 "i"（不区分大小写）。
 */

export interface HighlightRule {
  /** 内置规则为 b- 开头的固定 id，自定义规则为 c- 开头 */
  id: string;
  enabled: boolean;
  pattern: string;
  /** 内置规则为 null 时显示本地化的默认说明 */
  note: string | null;
  /** #RRGGBB */
  color: string;
  /** 正则标志，只允许 i；缺省为 "i" */
  flags?: string;
}

export interface HighlightSettings {
  enabled: boolean;
  rules: HighlightRule[];
  /** 用户删掉的内置规则，以后升级新增内置规则时不会再加回来 */
  removed: string[];
}

/** 单词类规则的结尾：不能用 \b（% 或 ) 后面是空格时 \b 不成立），改用“后面不是单词字符” */
const END = '(?![\\w])';

const BUILTIN: readonly Omit<HighlightRule, 'note'>[] = [
  { id: 'b-url', enabled: true, pattern: 'https?://[^\\s"\'<>]+', color: '#60a5fa' },
  { id: 'b-uuid', enabled: true, pattern: '\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b', color: '#818cf8' },
  {
    id: 'b-datetime',
    enabled: true,
    pattern:
      '\\b\\d{4}-\\d{2}-\\d{2}(?:[ T]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)?' +
      END +
      '|\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\\d{1,2} \\d{2}:\\d{2}:\\d{2}\\b',
    color: '#94a3b8',
  },
  { id: 'b-time', enabled: true, pattern: '\\b\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?\\b', color: '#94a3b8' },
  { id: 'b-mac', enabled: true, pattern: '\\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\\b', color: '#67e8f9' },
  {
    id: 'b-ipv6',
    enabled: true,
    // 只认完整 8 段或带 :: 的写法，避免把 12:34:56 这样的时间当成 IPv6
    pattern:
      '(?<![\\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{0,4}::(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{0,4})(?:/\\d{1,3})?(?![\\w:])',
    color: '#22d3ee',
  },
  {
    id: 'b-ipv4',
    enabled: true,
    pattern: '\\b(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)(?:/\\d{1,2}|:\\d{1,5})?\\b',
    color: '#22d3ee',
  },
  { id: 'b-path', enabled: true, pattern: '(?<![\\w.-])(?:~|\\.{1,2})?(?:/[\\w.@+-]+)+/?', color: '#a5b4fc' },
  {
    id: 'b-http-error',
    enabled: true,
    pattern:
      '(?<=HTTP/[\\d.]+"\\s)[45]\\d{2}\\b|\\b[45]\\d{2} (?:Bad|Unauthorized|Forbidden|Not|Method|Timeout|Too|Internal|Gateway|Service|Request)\\b',
    color: '#f87171',
  },
  { id: 'b-http-ok', enabled: true, pattern: '(?<=HTTP/[\\d.]+"\\s)[23]\\d{2}\\b', color: '#4ade80' },
  { id: 'b-http-method', enabled: true, pattern: '\\b(?:GET|POST|PUT|DELETE|HEAD|PATCH|OPTIONS|CONNECT|TRACE)(?= /)', color: '#60a5fa', flags: '' },
  { id: 'b-pid-port', enabled: true, pattern: '\\bpid[=: ]\\d+\\b|\\bport[=: ]\\d{1,5}\\b', color: '#fbbf24' },
  {
    id: 'b-container-bad',
    enabled: true,
    pattern: '\\b(?:CrashLoopBackOff|ImagePullBackOff|ErrImagePull|OOMKilled|Evicted|CreateContainerConfigError)\\b|\\bExited \\([1-9]\\d*\\)',
    color: '#f87171',
    flags: '',
  },
  {
    id: 'b-container-pending',
    enabled: true,
    pattern: '\\b(?:Pending|ContainerCreating|PodInitializing|Terminating|Restarting)\\b|\\bInit:\\d+/\\d+',
    color: '#f59e0b',
    flags: '',
  },
  {
    id: 'b-container-ok',
    enabled: true,
    pattern: '\\bRunning\\b|\\bUp (?:About )?(?:an?|\\d+) (?:seconds?|minutes?|hours?|days?|weeks?|months?)\\b|\\bExited \\(0\\)',
    color: '#4ade80',
    flags: '',
  },
  {
    id: 'b-number-unit',
    enabled: true,
    pattern:
      '\\b\\d+(?:\\.\\d+)?\\s?(?:ns|us|µs|ms|s|m|h|d|B|K|M|G|T|P|kB|KB|MB|GB|TB|KiB|MiB|GiB|TiB|bps|Kbps|Mbps|Gbps|%)' + END,
    color: '#c084fc',
    flags: '',
  },
  { id: 'b-hex', enabled: true, pattern: '\\b(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\\b', color: '#6b7280', flags: '' },
  {
    id: 'b-error',
    enabled: true,
    pattern:
      '\\b(?:error|errors|err|fatal|critical|crit|emerg|panic|fail(?:ed|ure|s)?|denied|refused|rejected|timeout|timed out|unreachable|exception|traceback|segfault|segmentation fault|core dumped|oom|out of memory|killed|abort(?:ed)?|corrupt(?:ed)?|invalid user|authentication failure|unable|cannot|can\'t|expired)' +
      END,
    color: '#f87171',
  },
  {
    id: 'b-warning',
    enabled: true,
    pattern:
      '\\b(?:warn(?:ing|ings)?|deprecated|retry(?:ing)?|retries|reconnect(?:ing)?|skipped|skipping|fallback|degraded|unhealthy|conflict|expir(?:ing|es)|throttl(?:ed|ing))' +
      END,
    color: '#f59e0b',
  },
  {
    id: 'b-success',
    enabled: true,
    pattern:
      '\\b(?:success(?:ful(?:ly)?)?|succeeded|passed|ok|done|ready|active \\(running\\)|started|completed?|established|connected|accepted|listening|enabled|loaded|mounted|up to date|healthy)' +
      END,
    color: '#4ade80',
  },
  {
    id: 'b-stopped',
    enabled: true,
    pattern: '\\b(?:inactive|dead|stopped|exited|disabled|not found|no such file(?: or directory)?|missing)' + END,
    color: '#fb923c',
  },
  { id: 'b-level-info', enabled: true, pattern: '\\b(?:INFO|NOTICE)\\b', color: '#60a5fa', flags: '' },
  { id: 'b-level-debug', enabled: true, pattern: '\\b(?:DEBUG|TRACE|VERBOSE)\\b', color: '#94a3b8', flags: '' },
];

export const BUILTIN_RULE_IDS: readonly string[] = BUILTIN.map((rule) => rule.id);

export function builtinRules(): HighlightRule[] {
  return BUILTIN.map((rule) => ({ ...rule, note: null }));
}

export function builtinRule(id: string): HighlightRule | null {
  const rule = BUILTIN.find((item) => item.id === id);
  return rule ? { ...rule, note: null } : null;
}

export function defaultSettings(): HighlightSettings {
  return { enabled: true, rules: builtinRules(), removed: [] };
}

// ---------- 校验 ----------

const COLOR = /^#[0-9a-f]{6}$/i;
const MAX_PATTERN = 2000;
const MAX_RULES = 200;

/** 正则写错时返回错误信息，否则返回 null */
export function patternError(pattern: string, flags = 'i'): string | null {
  if (!pattern) return 'empty';
  if (pattern.length > MAX_PATTERN) return 'too long';
  try {
    const regex = new RegExp(pattern, `g${flags}`);
    // 能匹配空字符串的规则会让每个位置都“命中”，没有意义
    if (regex.test('')) return 'matches empty text';
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function normalizeFlags(flags: unknown): string | undefined {
  if (flags === undefined || flags === null) return undefined;
  return String(flags).includes('i') ? 'i' : '';
}

function sanitizeRule(raw: unknown, fallbackId: () => string): HighlightRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const pattern = typeof item.pattern === 'string' ? item.pattern : '';
  const flags = normalizeFlags(item.flags);
  if (patternError(pattern, flags ?? 'i')) return null;
  const color = typeof item.color === 'string' && COLOR.test(item.color) ? item.color.toLowerCase() : '#f59e0b';
  const id = typeof item.id === 'string' && /^[bc]-[\w-]{1,64}$/.test(item.id) ? item.id : fallbackId();
  const note = typeof item.note === 'string' ? item.note.slice(0, 80) : null;
  const rule: HighlightRule = { id, enabled: item.enabled !== false, pattern, note, color };
  if (flags !== undefined) rule.flags = flags;
  return rule;
}

export function newRuleId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `c-${random.replace(/[^\w-]/g, '').slice(0, 36)}`;
}

// ---------- 存储 ----------

const STORAGE_KEY = 'cloudssh_terminal_highlight';
export const HIGHLIGHT_CHANGED_EVENT = 'cloudssh:highlight-changed';

export function loadSettings(): HighlightSettings {
  let stored: Partial<HighlightSettings> | null = null;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<HighlightSettings> | null;
  } catch {
    stored = null;
  }
  if (!stored || !Array.isArray(stored.rules)) return defaultSettings();
  const removed = Array.isArray(stored.removed) ? stored.removed.filter((id): id is string => typeof id === 'string') : [];
  const seen = new Set<string>();
  const rules: HighlightRule[] = [];
  for (const raw of stored.rules.slice(0, MAX_RULES)) {
    const rule = sanitizeRule(raw, newRuleId);
    if (!rule || seen.has(rule.id)) continue;
    seen.add(rule.id);
    rules.push(rule);
  }
  // 新版本增加的内置规则：用户没删过的补到末尾
  for (const rule of builtinRules()) {
    if (!seen.has(rule.id) && !removed.includes(rule.id)) rules.push(rule);
  }
  return { enabled: stored.enabled !== false, rules, removed };
}

export function saveSettings(settings: HighlightSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 存不下时只是不记忆
  }
  window.dispatchEvent(new CustomEvent(HIGHLIGHT_CHANGED_EVENT));
}

// ---------- 导入导出（与常见终端的格式一致） ----------

export interface ExportedRule {
  enabled: boolean;
  pattern: string;
  note: string;
  color: string;
  flags?: string;
}

export function exportRules(rules: HighlightRule[], noteOf: (rule: HighlightRule) => string): ExportedRule[] {
  return rules.map((rule) => {
    const item: ExportedRule = { enabled: rule.enabled, pattern: rule.pattern, note: noteOf(rule), color: rule.color };
    if (rule.flags !== undefined && rule.flags !== 'i') item.flags = rule.flags;
    return item;
  });
}

/** 解析导入的 JSON：返回能用的规则与被跳过的条数；整体不是数组时抛错 */
export function parseImport(text: string): { rules: HighlightRule[]; skipped: number } {
  const data = JSON.parse(text) as unknown;
  const list = Array.isArray(data) ? data : Array.isArray((data as { rules?: unknown })?.rules) ? (data as { rules: unknown[] }).rules : null;
  if (!list) throw new Error('not an array');
  const rules: HighlightRule[] = [];
  let skipped = 0;
  for (const raw of list.slice(0, MAX_RULES)) {
    // 导入的规则一律当作自定义规则（id 重新生成），避免与内置规则的 id 冲突
    const rule = sanitizeRule({ ...(raw as object), id: undefined }, newRuleId);
    if (rule) rules.push(rule);
    else skipped += 1;
  }
  return { rules, skipped };
}
