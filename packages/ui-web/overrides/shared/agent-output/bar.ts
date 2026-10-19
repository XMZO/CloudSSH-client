/**
 * AI 面板输入框下方的一行（电脑与手机共用）：模型、思考深度、上下文占用。
 * - 模型：当前模型，点开可搜索、切换（ai-model.ts，切换前先压缩，见 compact.ts）
 * - 思考深度：自动（不附带）/ 最低 / 低 / 中 / 高 / 超高，经 AI 增强代理加进请求（见 ai-model.ts），没部署代理时可看部署方法
 * - 联网：开关模型自己的原生联网搜索（同样经 AI 增强代理，版本 3 起），代理不支持时点按看部署方法
 * - 上下文：圆环显示估算的占用（meter.ts）；电脑悬停、手机点按弹出详情，可立即压缩、开关自动压缩
 */
import { onLocaleChange } from '../../../upstream/frontend/src/i18n';
import { copyTextToClipboard } from '../../../upstream/frontend/src/clipboard';
import { notify } from '../../../upstream/frontend/src/ui-feedback';
import {
  currentAiConfig,
  currentEffort,
  detectProxy,
  EFFORT_LABEL,
  EFFORTS,
  listModels,
  loadAiConfig,
  modelSupport,
  onAiConfig,
  proxyState,
  setEffort,
  setWebSearch,
  webSearchAvailable,
  webSearchEnabled,
} from './ai-model';
import proxySource from '../../../../../tools/reasoning-proxy/worker.js?raw';
import { autoCompactEnabled, compactPanel, isCompacting, onCompactChange, setAutoCompact, switchModel } from './compact';
import { at } from './i18n';
import { capacity, meterOf, onMeter, percentOf } from './meter';
import type { PanelInternals } from './recovery';

interface BarPanel extends PanelInternals {
  panelEl: HTMLElement | null;
}

interface Bar {
  panel: BarPanel;
  root: HTMLElement;
  render(): void;
}

const bars = new Set<Bar>();
const RING = 2 * Math.PI * 8;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: string, className = ''): HTMLSpanElement {
  const glyph = el('span', `material-symbols-outlined ${className}`.trim(), name);
  glyph.setAttribute('aria-hidden', 'true');
  return glyph;
}

function button(className: string): HTMLButtonElement {
  const node = el('button', className);
  node.type = 'button';
  return node;
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  return `${(value / 1000).toFixed(value < 100_000 ? 1 : 0).replace(/\.0$/, '')}K`;
}


// ---------- 弹出层 ----------

interface Popover {
  root: HTMLElement;
  anchor: HTMLElement;
  /** 悬停打开的（离开就关）；点过就固定 */
  hover: boolean;
  refill(): void;
  close(): void;
}

let popover: Popover | null = null;

function closePopover(): void {
  popover?.close();
  popover = null;
}

function place(root: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const width = root.offsetWidth;
  const height = root.offsetHeight;
  let left = rect.left;
  if (left + width > innerWidth - 8) left = rect.right - width;
  left = Math.max(8, Math.min(left, innerWidth - width - 8));
  let top = rect.top - height - 6;
  if (top < 8) top = Math.min(innerHeight - height - 8, rect.bottom + 6);
  root.style.left = `${Math.round(left)}px`;
  root.style.top = `${Math.round(Math.max(8, top))}px`;
}

function openPopover(anchor: HTMLElement, className: string, fill: (root: HTMLElement) => void, hover = false): Popover {
  closePopover();
  const root = el('div', `cs-pop ${className}`);
  root.setAttribute('role', 'dialog');
  root.tabIndex = -1;
  fill(root);
  document.body.append(root);
  place(root, anchor);
  anchor.setAttribute('aria-expanded', 'true');
  const outside = (event: PointerEvent) => {
    const target = event.target as Node;
    if (!root.contains(target) && !anchor.contains(target)) closePopover();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    closePopover();
    anchor.focus();
  };
  const reposition = () => place(root, anchor);
  document.addEventListener('pointerdown', outside, true);
  root.addEventListener('keydown', key);
  window.addEventListener('resize', reposition);
  const current: Popover = {
    root,
    anchor,
    hover,
    refill() {
      root.replaceChildren();
      fill(root);
      place(root, anchor);
    },
    close() {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', reposition);
      anchor.setAttribute('aria-expanded', 'false');
      root.remove();
    },
  };
  popover = current;
  return current;
}

// ---------- 上下文 ----------

function fillContext(root: HTMLElement, panel: BarPanel): void {
  const state = meterOf(panel);
  const pct = percentOf(state);
  const has = state.tokens > 0 || state.projected > 0;
  const head = el('div', 'cs-pop-head');
  head.append(el('span', 'cs-pop-title', at('ctxTitle')), el('strong', 'cs-pop-value', has ? `${Math.round(pct * 100)}%` : '—'));
  root.append(head);
  const meter = el('div', 'cs-pop-meter');
  meter.dataset.level = pct >= 0.9 ? 'bad' : pct >= 0.7 ? 'warn' : 'ok';
  const fill = el('i');
  fill.style.width = `${Math.min(100, pct * 100).toFixed(1)}%`;
  meter.append(fill);
  root.append(meter);
  if (!has) root.append(el('p', 'cs-pop-line', at('ctxEmpty')));
  else if (state.tokens) {
    const usage = at('ctxUsage', { used: formatTokens(state.tokens), total: formatTokens(capacity()) });
    root.append(el('p', 'cs-pop-line', state.estimated ? `${usage}（${at('ctxEstimated')}）` : usage));
  } else root.append(el('p', 'cs-pop-line', at('ctxProjected', { used: formatTokens(state.projected) })));
  const last = state.last;
  if (last && last.reportedCalls) {
    let text = at('ctxLast', { calls: last.calls, input: formatTokens(last.input), output: formatTokens(last.output) });
    if (last.reasoning) text += at('ctxReasoning', { n: formatTokens(last.reasoning) });
    root.append(el('p', 'cs-pop-line is-muted', text));
  }
  // 缓存命中：输入里有多少是接口缓存命中的（上一轮、这个面板累计；服务商不回报时为 0）
  const cacheLine = (key: 'ctxCache' | 'ctxCacheTotal', cached: number, input: number) =>
    el('p', 'cs-pop-line is-muted', at(key, { cached: formatTokens(cached), input: formatTokens(input), pct: Math.round((cached / input) * 100) }));
  if (last && last.reportedCalls && last.input > 0) root.append(cacheLine('ctxCache', last.cached, last.input));
  if (state.totalInput > 0 && state.totalInput !== last?.input) root.append(cacheLine('ctxCacheTotal', state.totalCached, state.totalInput));
  const compactions = state.compactions + state.workerCompactions;
  if (compactions) root.append(el('p', 'cs-pop-line is-muted', at('ctxCompactions', { n: compactions })));
  root.append(el('p', 'cs-pop-note', at('ctxExplain', { total: formatTokens(capacity()) })));

  const foot = el('div', 'cs-pop-foot');
  const auto = el('label', 'cs-pop-check');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = autoCompactEnabled();
  box.addEventListener('change', () => setAutoCompact(box.checked));
  auto.append(box, el('span', '', at('ctxAuto')));
  const now = button('cs-pop-btn');
  now.append(icon('compress'), el('span', '', at('ctxCompactNow')));
  now.title = at('ctxCommandHint');
  now.disabled = !state.turns || panel.isAgentRunning || isCompacting(panel);
  now.addEventListener('click', () => {
    closePopover();
    void compactPanel(panel, 'manual');
  });
  foot.append(auto, now);
  root.append(foot);
}

function renderRing(ring: HTMLButtonElement, panel: BarPanel): void {
  const state = meterOf(panel);
  const pct = percentOf(state);
  const has = state.tokens > 0 || state.projected > 0;
  const arc = ring.querySelector<SVGCircleElement>('.cs-ring-fill');
  arc?.setAttribute('stroke-dashoffset', String(RING * (1 - Math.min(1, has ? pct : 0))));
  ring.dataset.level = pct >= 0.9 ? 'bad' : pct >= 0.7 ? 'warn' : 'ok';
  ring.dataset.busy = isCompacting(panel) ? 'true' : 'false';
  const label = ring.querySelector('.cs-ring-pct');
  if (label) label.textContent = has ? `${Math.round(pct * 100)}%` : '';
  ring.setAttribute('aria-label', has ? at('ctxAria', { pct: Math.round(pct * 100) }) : at('ctxAriaEmpty'));
}

function buildRing(): HTMLButtonElement {
  const ring = button('cs-bar-ring');
  ring.setAttribute('aria-haspopup', 'dialog');
  ring.setAttribute('aria-expanded', 'false');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(ns, 'circle');
  track.setAttribute('class', 'cs-ring-track');
  const fill = document.createElementNS(ns, 'circle');
  fill.setAttribute('class', 'cs-ring-fill');
  fill.setAttribute('stroke-dasharray', String(RING));
  fill.setAttribute('transform', 'rotate(-90 10 10)');
  for (const circle of [track, fill]) {
    circle.setAttribute('cx', '10');
    circle.setAttribute('cy', '10');
    circle.setAttribute('r', '8');
  }
  svg.append(track, fill);
  ring.append(svg, el('span', 'cs-ring-pct'));
  return ring;
}

/** 圆环：电脑悬停弹出、移开收起；点按（手机只有点按）固定打开 / 关闭 */
function bindRing(ring: HTMLButtonElement, panel: BarPanel): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fine = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
  const open = (hover: boolean) => openPopover(ring, 'cs-pop-context', (root) => fillContext(root, panel), hover);
  const later = (fn: () => void, ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
  const leave = () =>
    later(() => {
      if (popover?.anchor === ring && popover.hover && !popover.root.matches(':hover')) closePopover();
    }, 220);
  ring.addEventListener('pointerenter', () => {
    if (!fine() || popover?.anchor === ring) return;
    later(() => {
      const current = open(true);
      current.root.addEventListener('pointerleave', leave);
    }, 140);
  });
  ring.addEventListener('pointerleave', () => {
    if (timer) clearTimeout(timer);
    if (fine()) leave();
  });
  ring.addEventListener('click', () => {
    if (timer) clearTimeout(timer);
    if (popover?.anchor === ring) {
      if (popover.hover) popover.hover = false;
      else closePopover();
      return;
    }
    open(false);
  });
}

// ---------- 模型 ----------

function fillModels(root: HTMLElement, panel: BarPanel): void {
  const config = currentAiConfig();
  root.append(el('div', 'cs-pop-title', at('modelTitle')));
  if (!config?.configured) {
    root.append(el('p', 'cs-pop-line', at('modelNotConfigured')));
    root.append(settingsButton());
    return;
  }
  const base = config.model ?? '';
  const search = el('input', 'cs-pop-search');
  search.type = 'search';
  search.placeholder = at('modelSearch');
  search.setAttribute('aria-label', at('modelSearch'));
  search.autocomplete = 'off';
  search.spellcheck = false;
  const list = el('div', 'cs-pop-list');
  list.setAttribute('role', 'listbox');
  root.append(search, list, settingsButton());
  let models: string[] | null = null;
  let error = '';
  const choose = (name: string) => {
    closePopover();
    void switchModel(panel, name);
  };
  const render = () => {
    list.replaceChildren();
    const query = search.value.trim();
    if (!models && !error) {
      list.append(el('p', 'cs-pop-line is-muted', at('modelLoading')));
      return;
    }
    if (error) list.append(el('p', 'cs-pop-line is-error', at('modelListFailed', { reason: error })));
    const matches = (models ?? []).filter((name) => name.toLowerCase().includes(query.toLowerCase()));
    for (const name of matches.slice(0, 200)) {
      const item = button('cs-pop-item');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(name === base));
      item.append(el('span', 'cs-pop-item-name', name));
      if (name === base) item.append(icon('check', 'cs-pop-check-icon'));
      item.addEventListener('click', () => choose(name));
      list.append(item);
    }
    // 接口不给列表、或列表里没有：可以直接用输入的名字
    if (query && !matches.includes(query)) {
      const custom = button('cs-pop-item');
      custom.append(icon('edit', 'cs-pop-item-icon'), el('span', 'cs-pop-item-name', at('modelUse', { model: query })));
      custom.addEventListener('click', () => choose(query));
      list.append(custom);
    } else if (!matches.length && !error) list.append(el('p', 'cs-pop-line is-muted', at('modelNone')));
    if (popover?.root === root) place(root, popover.anchor);
  };
  search.addEventListener('input', render);
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    list.querySelector<HTMLButtonElement>('.cs-pop-item')?.click();
  });
  render();
  listModels()
    .then((items) => {
      models = items;
    })
    .catch((reason: unknown) => {
      models = [];
      error = reason instanceof Error ? reason.message : String(reason);
    })
    .finally(render);
  requestAnimationFrame(() => search.focus());
}

function settingsButton(): HTMLButtonElement {
  const node = button('cs-pop-link');
  node.append(icon('settings'), el('span', '', at('modelSettings')));
  node.addEventListener('click', () => {
    closePopover();
    document.getElementById('ai-config-btn')?.click();
  });
  return node;
}

// ---------- 思考深度 ----------

/** 代理状态一行：已生效 / 没设 UPSTREAM / 没部署（附部署方法） */
function proxyLine(): HTMLElement {
  const state = proxyState();
  const line = el('div', 'cs-pop-status');
  line.dataset.state = state;
  const key = state === 'ok' ? 'effortActive' : state === 'no-upstream' ? 'effortNoUpstream' : state === 'checking' ? 'effortChecking' : 'effortInactive';
  line.append(icon(state === 'ok' ? 'check_circle' : state === 'checking' ? 'pending' : 'info'), el('span', '', at(key)));
  if (state !== 'ok' && state !== 'checking') {
    const how = button('cs-pop-inline');
    how.textContent = at('effortDeploy');
    how.addEventListener('click', () => {
      closePopover();
      openDeployGuide();
    });
    line.append(how);
  }
  return line;
}

function fillEffort(root: HTMLElement, panel: BarPanel): void {
  const config = currentAiConfig();
  const effort = currentEffort();
  root.append(el('div', 'cs-pop-title', at('effortTitle')), proxyLine());
  const list = el('div', 'cs-pop-list');
  list.setAttribute('role', 'listbox');
  for (const value of EFFORTS) {
    const item = button('cs-pop-item');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(value === effort));
    const text = el('span', 'cs-pop-item-text');
    text.append(
      el('span', 'cs-pop-item-name', at(EFFORT_LABEL[value])),
      el('span', 'cs-pop-item-hint', value === 'auto' ? at('effortAutoHint') : `reasoning.effort = ${value}`)
    );
    item.append(text);
    if (value === effort) item.append(icon('check', 'cs-pop-check-icon'));
    item.disabled = !config?.configured;
    item.addEventListener('click', () => {
      closePopover();
      // 每条消息各自带标记，下一条就按新的来，不用开新会话
      setEffort(value);
    });
    list.append(item);
  }
  root.append(list);
  // 验证是否生效：接口回报的推理用量（同一个问题换档位对比），代理日志里也有每次请求的档位
  const last = meterOf(panel).last;
  if (proxyState() === 'ok') {
    if (last?.reportedCalls) root.append(el('p', 'cs-pop-line', at('effortLastReasoning', { n: formatTokens(last.reasoning) })));
    root.append(el('p', 'cs-pop-note', at('effortVerify')));
  }
  root.append(el('p', 'cs-pop-note', at('effortExplain')));
  // 还没检测过代理：检测完重画一次（检测过就不再触发，免得来回重画）
  if (proxyState() === 'checking') {
    void detectProxy().then(() => {
      if (popover?.root === root && proxyState() !== 'checking') popover.refill();
    });
  }
}

let guideRoot: HTMLElement | null = null;

function closeGuide(): void {
  guideRoot?.remove();
  guideRoot = null;
}

async function copy(text: string): Promise<void> {
  const ok = await copyTextToClipboard(text);
  notify(at(ok ? 'deployCopied' : 'deployCopyFailed'), { variant: ok ? 'success' : 'warning', duration: 2000 });
}

/** 部署思考深度代理的步骤（代理代码内置，可一键复制） */
function openDeployGuide(): void {
  closeGuide();
  const config = currentAiConfig();
  const state = proxyState();
  const root = el('div', 'cs-as-root');
  const dialog = el('div', 'cs-as-dialog cs-deploy-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', at('deployTitle'));
  dialog.tabIndex = -1;
  const head = el('div', 'cs-as-head');
  head.append(el('h2', 'cs-as-title', at('deployTitle')));
  const close = button('cs-as-close');
  close.setAttribute('aria-label', at('cancel'));
  close.append(icon('close'));
  close.addEventListener('click', closeGuide);
  head.append(close);
  const body = el('div', 'cs-as-body cs-deploy-body');
  body.append(el('p', 'cs-deploy-intro', at('deployIntro')), el('p', 'cs-deploy-warn', at('deployZone')));
  const steps = el('ol', 'cs-deploy-steps');
  const step = (text: string, ...extra: HTMLElement[]) => {
    const li = el('li');
    li.append(el('span', '', text), ...extra);
    steps.append(li);
  };
  const action = (label: string, glyph: string, run: () => void) => {
    const node = button('cs-pop-btn cs-deploy-action');
    node.append(icon(glyph), el('span', '', label));
    node.addEventListener('click', run);
    return node;
  };
  step(at('deployStep1'), action(at('deployCopyCode'), 'content_copy', () => void copy(proxySource)));
  const base = config?.base_url ?? '';
  if (state === 'ok' || state === 'no-upstream') {
    step(at('deployStep2Proxy'));
  } else {
    const code = el('code', 'cs-deploy-code', base || '—');
    step(at('deployStep2'), code, ...(base ? [action(at('deployCopy'), 'content_copy', () => void copy(base))] : []));
  }
  step(
    at('deployStep3'),
    action(at('modelSettings'), 'settings', () => {
      closeGuide();
      document.getElementById('ai-config-btn')?.click();
    })
  );
  const status = el('span', 'cs-deploy-status');
  const recheck = action(at('deployRecheck'), 'refresh', () => {
    status.textContent = at('effortChecking');
    void loadAiConfig(true)
      .then(() => detectProxy(true))
      .then((result) => {
        status.textContent = at(result === 'ok' ? 'effortActive' : result === 'no-upstream' ? 'effortNoUpstream' : 'effortInactive');
        status.dataset.state = result;
      });
  });
  status.textContent = at(state === 'ok' ? 'effortActive' : state === 'no-upstream' ? 'effortNoUpstream' : 'effortInactive');
  status.dataset.state = state;
  step(at('deployStep4'), recheck, status);
  body.append(steps, el('p', 'cs-pop-note', at('deploySearch')), el('p', 'cs-pop-note', at('deployNote')));
  dialog.append(head, body);
  root.append(dialog);
  document.body.append(root);
  guideRoot = root;
  root.addEventListener('pointerdown', (event) => {
    if (event.target === root) closeGuide();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    closeGuide();
  });
  dialog.focus();
}

// ---------- 一行 ----------

function renderAll(): void {
  for (const bar of [...bars]) {
    if (!bar.root.isConnected) bars.delete(bar);
    else bar.render();
  }
}

/** 面板渲染完（构建钩子）后加到输入框下方 */
export function addComposerBar(panel: unknown): void {
  // 面板刚渲染完时网页版还没接上 WebSocket（wsSend 为空），这里只看 DOM；压缩、切换时再检查
  const p = panel as BarPanel | null;
  if (!p || typeof p !== 'object' || !Array.isArray(p.sessionMessages)) return;
  const composer = p.panelEl?.querySelector('.agent-panel-composer');
  if (!composer || composer.querySelector('.cs-agent-bar')) return;
  const root = el('div', 'cs-agent-bar');
  const model = button('cs-bar-btn cs-bar-model');
  model.setAttribute('aria-haspopup', 'dialog');
  const modelName = el('span', 'cs-bar-label');
  model.append(icon('neurology'), modelName, icon('expand_more', 'cs-bar-caret'));
  const effort = button('cs-bar-btn cs-bar-effort');
  effort.setAttribute('aria-haspopup', 'dialog');
  const effortName = el('span', 'cs-bar-label');
  effort.append(icon('psychology'), effortName);
  const search = button('cs-bar-btn cs-bar-search');
  search.append(icon('travel_explore'), el('span', 'cs-bar-label', at('searchLabel')));
  const ring = buildRing();
  root.append(model, effort, search, el('span', 'cs-bar-spacer'), ring);
  composer.append(root);

  const render = () => {
    const config = currentAiConfig();
    const level = currentEffort();
    const active = proxyState() === 'ok';
    modelName.textContent = !config ? '…' : config.configured ? config.model || at('modelUnset') : at('modelUnset');
    model.title = `${at('modelTitle')}: ${config?.model ?? ''}`.trim();
    // 当前模型已知不支持（DeepSeek 等）：按钮变灰、点不了，消息里也不带（见 ai-model.ts modelSupport）
    const support = modelSupport();
    const modelLabel = config?.model ?? '';
    const noReasoning = support.reasoning === 'no';
    effortName.textContent = noReasoning ? at('effortNA') : at(EFFORT_LABEL[level]);
    effort.disabled = noReasoning;
    effort.dataset.unsupported = String(noReasoning);
    // 选了档位但代理没生效：变暗，提示看部署方法
    effort.dataset.inactive = String(!noReasoning && level !== 'auto' && !active);
    effort.title = noReasoning
      ? at('effortUnsupported', { model: modelLabel })
      : `${at('effortTitle')}: ${at(EFFORT_LABEL[level])}${level !== 'auto' && !active ? ` · ${at('effortInactive')}` : ''}`;
    effort.hidden = !config?.configured;
    const on = webSearchEnabled();
    const available = webSearchAvailable();
    const noSearch = support.search === 'no';
    search.hidden = !config?.configured;
    search.disabled = noSearch;
    search.dataset.unsupported = String(noSearch);
    search.setAttribute('aria-pressed', String(on && available && !noSearch));
    search.dataset.inactive = String(on && !available && !noSearch);
    const searchLabel = search.querySelector('.cs-bar-label');
    if (searchLabel) searchLabel.textContent = at('searchLabel');
    search.title = noSearch
      ? at('searchUnsupported', { model: modelLabel })
      : !available
        ? at(on ? 'searchUnavailableOn' : 'searchUnavailable')
        : at(on ? 'searchOn' : 'searchOff');
    renderRing(ring, p);
    if (popover && popover.anchor === ring) popover.refill();
  };
  bars.add({ panel: p, root, render });
  model.addEventListener('click', () => {
    if (popover?.anchor === model) return closePopover();
    void loadAiConfig().then(() => openPopover(model, 'cs-pop-model', (box) => fillModels(box, p)));
  });
  effort.addEventListener('click', () => {
    if (popover?.anchor === effort) return closePopover();
    void loadAiConfig().then(() => openPopover(effort, 'cs-pop-effort', (box) => fillEffort(box, p)));
  });
  search.addEventListener('click', () => {
    closePopover();
    // 代理还不支持（没部署、或是旧版本）：先看部署方法；开着的仍可关掉
    if (!webSearchAvailable() && !webSearchEnabled()) {
      void loadAiConfig()
        .then(() => detectProxy())
        .then(() => (webSearchAvailable() ? setWebSearch(true) : openDeployGuide()));
      return;
    }
    setWebSearch(!webSearchEnabled());
  });
  bindRing(ring, p);
  render();
  void loadAiConfig();
}

let installed = false;

export function installComposerBar(): void {
  if (installed) return;
  installed = true;
  onAiConfig(renderAll);
  onLocaleChange(renderAll);
  const renderPanel = (panel: object) => {
    for (const bar of bars) if (bar.panel === panel) bar.render();
  };
  onMeter(renderPanel);
  onCompactChange(renderPanel);
}
