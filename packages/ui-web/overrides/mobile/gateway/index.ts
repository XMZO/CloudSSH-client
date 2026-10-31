/**
 * 手机端的入口网关（tools/gateway）：节点页顶部的网关状态条、设置 → 实例里的“入口网关”一行与管理面板。
 * 状态与接口和电脑共用（../../shared/gateway/model.ts）；普通实例没有网关接口，这些都不显示，也不再去问。
 *
 * 管理面板：各节点今天的用量与暂停原因、暂停 1 小时 / 恢复、立即同步；分流策略、节点顺序、各节点上限
 * （改了点保存，立即生效，可恢复默认）；签发、吊销长期令牌（新令牌只显示一次）。长期令牌只能看状态，
 * 改设置要用这里（网页 / 客户端）的登录。
 */
import { notify } from '../../../upstream/frontend/src/ui-feedback';
import {
  downKind,
  type GatewayDown,
  gatewayApi,
  type GatewayPolicy,
  type GatewayStatus,
  type GatewayToken,
  mappedServers,
  percentText,
  probeGateway,
} from '../../shared/gateway/model';
import { segmented, settingsGroup, settingsRow, smallButton } from '../settings-ui';
import { confirmSheet, el, icon, openSheet } from '../sheet';
import { native } from '../tauri';
import { gt, onLocaleChange } from './i18n';
import './gateway.css';

const REFRESH_MS = 60_000;
/** 管理面板改了状态后通知状态条（detail 是新的 GatewayStatus） */
const STATUS_EVENT = 'cloudssh:gateway-status';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const fail = (error: unknown) => notify(gt('failed', { reason: errorText(error) }), { variant: 'danger' });

function publish(status: GatewayStatus): void {
  window.dispatchEvent(new CustomEvent<GatewayStatus>(STATUS_EVENT, { detail: status }));
}

const nodeLabel = (status: GatewayStatus, name: string, home: boolean) => `${name}${home && status.nodes.length > 1 ? '*' : ''}`;

function nodesText(status: GatewayStatus): string {
  return status.nodes.map((node) => `${nodeLabel(status, node.name, node.home)} ${percentText(node.ratio)}%`).join(' · ');
}

const timeText = (at: number) => new Date(at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dateText = (at: number) => new Date(at).toLocaleDateString([], { year: 'numeric', month: 'numeric', day: 'numeric' });

function agoText(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return gt('justNow');
  if (minutes < 60) return gt('minutesAgo', { n: minutes });
  return gt('hoursAgo', { n: Math.round(minutes / 60) });
}

function downText(down: GatewayDown): string {
  const kind = downKind(down);
  if (kind === 'manual') return gt('downManual');
  if (kind === 'quota') return gt('downQuota');
  return gt('downError', { reason: down.reason });
}

/** 确定当前实例不是网关后不再去问（换实例会重新加载页面，这个标记随之清掉） */
let notGateway = false;

async function probe(): Promise<GatewayStatus | 'none' | 'unknown'> {
  if (notGateway) return 'none';
  const result = await probeGateway();
  if (result === 'none') notGateway = true;
  return result;
}

/** 定时读状态：确定不是网关（'none'）就停；页面在后台时不读，回到前台马上读一次 */
function watchGateway(onStatus: (status: GatewayStatus | null) => void): void {
  let stopped = false;
  const refresh = async () => {
    if (stopped || document.visibilityState === 'hidden') return;
    const result = await probe();
    if (result === 'none') {
      stopped = true;
      window.clearInterval(timer);
      onStatus(null);
    } else if (result !== 'unknown') {
      onStatus(result);
    }
  };
  const timer = window.setInterval(() => void refresh(), REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });
  window.addEventListener(STATUS_EVENT, (event) => {
    if (!stopped) onStatus((event as CustomEvent<GatewayStatus>).detail);
  });
  void refresh();
}

// ---------- 节点页顶部的状态条 ----------

/** 节点页的网关状态条：“A 12% · B* 3%  新会话放 A”，点开管理面板。不是网关时一直隐藏 */
export function gatewayStrip(): HTMLElement {
  const strip = el('button', 'cs-gw-strip');
  strip.type = 'button';
  strip.hidden = true;
  let status: GatewayStatus | null = null;
  const render = () => {
    strip.hidden = !status;
    if (!status) return;
    const nodes = el('span', 'cs-gw-strip-nodes');
    status.nodes.forEach((node, index) => {
      if (index) nodes.append(el('span', 'cs-gw-strip-dot', '·'));
      const item = el('span', 'cs-gw-strip-node', `${nodeLabel(status!, node.name, node.home)} ${percentText(node.ratio)}%`);
      item.classList.toggle('is-next', node.name === status!.next);
      item.classList.toggle('is-down', !!node.down);
      nodes.append(item);
    });
    strip.replaceChildren(icon('lan'), nodes, el('span', 'cs-gw-strip-next', status.next ? gt('stripNext', { next: status.next }) : ''), icon('chevron_right'));
    strip.setAttribute('aria-label', `${gt('title')}：${nodesText(status)}`);
  };
  strip.addEventListener('click', () => openGatewaySheet(status));
  onLocaleChange(render);
  watchGateway((next) => {
    status = next;
    render();
  });
  return strip;
}

// ---------- 设置 → 实例里的一行 ----------

/** 当前实例是网关时显示“入口网关”一行（节点用量与新会话去向），点开管理面板；不是网关时隐藏 */
export function gatewaySettingsRow(): HTMLElement {
  let status: GatewayStatus | null = null;
  const row = settingsRow({ title: gt('title'), sub: '', lead: 'lan', onClick: () => openGatewaySheet(status) });
  row.hidden = true;
  const sub = row.querySelector<HTMLElement>('.cs-set-sub');
  void probe().then((result) => {
    if (typeof result === 'string') return;
    status = result;
    if (sub) sub.textContent = gt('rowSub', { nodes: nodesText(result), next: result.next ?? '-' });
    row.hidden = false;
  });
  return row;
}

// ---------- 管理面板 ----------

interface Draft {
  policy: GatewayPolicy;
  order: string[];
  limits: Record<string, number>;
}

function draftOf(status: GatewayStatus): Draft {
  return {
    policy: status.policy,
    order: status.settings?.order ?? status.nodes.map((node) => node.name),
    limits: Object.fromEntries(status.nodes.map((node) => [node.name, status.settings?.limits[node.name] ?? node.limit ?? 0.9])),
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.policy === b.policy &&
    a.order.join() === b.order.join() &&
    Object.keys({ ...a.limits, ...b.limits }).every((name) => Math.abs((a.limits[name] ?? 0.9) - (b.limits[name] ?? 0.9)) < 0.001)
  );
}

export function openGatewaySheet(initial: GatewayStatus | null = null): void {
  let status = initial;
  let draft: Draft | null = status ? draftOf(status) : null;

  const page = el('div', 'cs-set-page cs-gw-page');
  const intro = el('p', 'cs-gw-intro', gt('intro'));

  // 同步
  const syncText = el('span', 'cs-set-sub cs-gw-sync-text');
  const syncButton = smallButton(gt('sync'), () => {
    syncButton.disabled = true;
    syncButton.textContent = gt('syncing');
    void gatewayApi
      .sync()
      .then(apply)
      .catch(fail)
      .finally(() => {
        syncButton.disabled = false;
        syncButton.textContent = gt('sync');
      });
  });
  const refreshButton = smallButton(gt('refresh'), () => void load());
  const syncRow = el('div', 'cs-set-row cs-gw-sync');
  const syncBox = el('span', 'cs-set-text');
  syncBox.append(syncText);
  const syncActions = el('span', 'cs-gw-actions');
  syncActions.append(refreshButton, syncButton);
  syncRow.append(syncBox, syncActions);

  // 节点
  const nodeList = el('div', 'cs-gw-nodes');

  // 分流策略
  const policyDesc = el('p', 'cs-gw-desc');
  const policyRow = el('div', 'cs-set-row is-wrap');
  const policyText = el('span', 'cs-set-text');
  policyText.append(el('span', 'cs-set-title', gt('policy')));
  const saveState = el('span', 'cs-set-sub cs-gw-save-state');
  const resetButton = smallButton(gt('reset'), () => {
    void confirmSheet(gt('resetConfirm'), gt('reset'), gt('cancel')).then((ok) => {
      if (ok) void gatewayApi.saveSettings(null).then(apply).catch(fail);
    });
  });
  const saveButton = smallButton(gt('save'), () => {
    if (!draft) return;
    const { policy, order, limits } = draft;
    void gatewayApi
      .saveSettings({ policy, order, limits })
      .then((next) => {
        apply(next);
        notify(gt('saved'), { variant: 'success', duration: 1500 });
      })
      .catch(fail);
  });
  saveButton.classList.add('is-primary');
  const saveRow = el('div', 'cs-set-row cs-gw-save');
  const saveActions = el('span', 'cs-gw-actions');
  saveActions.append(resetButton, saveButton);
  saveRow.append(saveState, saveActions);

  // 长期令牌
  const tokenHint = el('p', 'cs-gw-desc', gt('tokensHint'));
  const tokenList = el('div', 'cs-gw-tokens');
  const labelInput = el('input', 'cs-set-input cs-gw-token-label');
  labelInput.type = 'text';
  labelInput.maxLength = 64;
  labelInput.placeholder = gt('tokenLabel');
  labelInput.enterKeyHint = 'done';
  const daysSelect = el('select', 'cs-set-input cs-gw-token-days');
  daysSelect.setAttribute('aria-label', gt('days365'));
  for (const [value, key] of [['30', 'days30'], ['90', 'days90'], ['365', 'days365'], ['0', 'days0']] as const) {
    daysSelect.append(new Option(gt(key), value, value === '365', value === '365'));
  }
  const issueButton = smallButton(gt('issue'), () => {
    const label = labelInput.value.trim();
    if (!label) {
      notify(gt('tokenNeedLabel'), { variant: 'warning' });
      labelInput.focus();
      return;
    }
    void gatewayApi
      .issueToken(label, Number(daysSelect.value))
      .then((issued) => {
        labelInput.value = '';
        showNewToken(issued.token);
        void loadTokens();
      })
      .catch(fail);
  });
  const issueRow = el('div', 'cs-set-row cs-gw-issue');
  issueRow.append(labelInput, daysSelect, issueButton);
  const newToken = el('div', 'cs-set-row cs-gw-new-token');
  newToken.hidden = true;

  function showNewToken(token: string): void {
    const value = el('code', 'cs-gw-token-value', token);
    const copy = smallButton(gt('copy'), () => {
      void native
        .clipboardWrite(token)
        .then(() => notify(gt('copied'), { variant: 'success', duration: 1200 }))
        .catch(fail);
    });
    const text = el('span', 'cs-set-text');
    text.append(el('span', 'cs-set-sub', gt('tokenNew')), value);
    newToken.replaceChildren(text, copy);
    newToken.hidden = false;
  }

  page.append(
    intro,
    settingsGroup('gw-sync', gt('nodes'), [syncRow, nodeList]),
    settingsGroup('gw-policy', gt('policy'), [policyRow, saveRow]),
    settingsGroup('gw-tokens', gt('tokens'), [tokenList, issueRow, newToken])
  );
  page.querySelector('[data-group="gw-tokens"] .cs-set-card')?.before(tokenHint);
  page.querySelector('[data-group="gw-policy"] .cs-set-group-title')?.remove();

  function renderNodes(): void {
    if (!status || !draft) return;
    const current = status;
    const plan = draft;
    const byName = new Map(current.nodes.map((node) => [node.name, node]));
    const names = [...plan.order.filter((name) => byName.has(name)), ...current.nodes.map((node) => node.name).filter((name) => !plan.order.includes(name))];
    nodeList.replaceChildren(
      ...names.map((name, index) => {
        const node = byName.get(name)!;
        const block = el('div', 'cs-gw-node');

        const head = el('div', 'cs-gw-node-head');
        if (plan.policy === 'fill' && names.length > 1) {
          const move = (offset: number, glyph: string, label: string) => {
            const button = el('button', 'cs-gw-move');
            button.type = 'button';
            button.setAttribute('aria-label', `${label} ${name}`);
            button.append(icon(glyph));
            button.disabled = index + offset < 0 || index + offset >= names.length;
            button.addEventListener('click', () => {
              const next = [...names];
              [next[index], next[index + offset]] = [next[index + offset], next[index]];
              plan.order = next;
              renderAll();
            });
            return button;
          };
          head.append(move(-1, 'arrow_upward', gt('moveUp')), move(1, 'arrow_downward', gt('moveDown')));
        }
        head.append(el('strong', 'cs-gw-node-name', name));
        if (node.home) head.append(el('span', 'cs-gw-badge is-home', gt('home')));
        if (current.next === name) head.append(el('span', 'cs-gw-badge', gt('next')));
        const action = smallButton(node.down ? gt('resume') : gt('pause'), () => {
          void gatewayApi.pause(name, node.down ? null : 60).then(apply).catch(fail);
        });
        action.classList.add('cs-gw-node-action');
        head.append(action);

        const bar = el('div', 'cs-gw-bar');
        const fill = el('span');
        const ratio = node.ratio ?? 0;
        fill.style.width = `${Math.min(ratio, 1) * 100}%`;
        bar.classList.toggle('is-over', ratio >= 1);
        bar.classList.toggle('is-near', ratio < 1 && ratio >= (plan.limits[name] ?? 0.9));
        bar.append(fill);

        const info = el('div', 'cs-gw-node-info');
        info.append(
          el('span', '', node.ratio == null ? gt('usageUnknown') : gt('usage', { pct: percentText(node.ratio), gbs: Math.round(node.gbs ?? 0).toLocaleString() }))
        );
        const state = el('span', node.down ? 'is-down' : 'is-ok', node.down ? `${gt('downUntil', { time: timeText(node.down.until) })} · ${downText(node.down)}` : gt('ok'));
        info.append(state);
        if (node.mapped && node.mapped.stale > 0) info.append(el('span', '', gt('stale', { n: node.mapped.stale })));

        const limitRow = el('div', 'cs-gw-limit');
        const value = el('span', 'cs-gw-limit-value', `${Math.round((plan.limits[name] ?? 0.9) * 100)}%`);
        const step = (delta: number, glyph: string) => {
          const button = el('button', 'cs-gw-step', glyph);
          button.type = 'button';
          button.setAttribute('aria-label', `${gt('limit')} ${glyph}`);
          button.addEventListener('click', () => {
            const next = Math.min(Math.max(Math.round((plan.limits[name] ?? 0.9) * 100) + delta, 5), 100);
            plan.limits[name] = next / 100;
            renderAll();
          });
          return button;
        };
        const limitLabel = el('span', 'cs-gw-limit-label', gt('limit'));
        limitLabel.title = gt('limitHint');
        limitRow.append(limitLabel, step(-5, '−'), value, step(5, '+'));
        if (!current.settings) limitRow.hidden = true;

        block.append(head, bar, info, limitRow);
        return block;
      })
    );
  }

  function renderAll(): void {
    if (!status || !draft) return;
    const sync = status.lastSync;
    syncText.textContent = sync
      ? gt('syncState', { ago: agoText(sync.at), n: mappedServers(status) }) +
        (sync.errors.length ? `\n${gt('syncIssues', { n: sync.errors.length, first: sync.errors[0] })}` : '')
      : gt('syncNever');
    syncText.classList.toggle('is-bad', !!sync?.errors.length);
    renderNodes();

    const plan = draft;
    const control = segmented<GatewayPolicy>(
      gt('policy'),
      [
        { value: 'fill', label: gt('fill') },
        { value: 'even', label: gt('even') },
      ],
      plan.policy,
      (value) => {
        plan.policy = value;
        renderAll();
      }
    );
    control.classList.add('cs-set-end');
    policyRow.replaceChildren(policyText, control, policyDesc);
    policyDesc.textContent = plan.policy === 'fill' ? gt('fillDesc') : gt('evenDesc');

    const editable = !!status.settings;
    const dirty = editable && !sameDraft(plan, draftOf(status));
    saveButton.disabled = !dirty;
    resetButton.disabled = !editable || (!status.settings?.custom && !dirty);
    control.querySelectorAll('button').forEach((button) => (button.disabled = !editable));
    saveState.textContent = !editable ? gt('oldGateway') : dirty ? gt('dirty') : status.settings?.custom ? gt('custom') : gt('defaults');
  }

  function apply(next: GatewayStatus): void {
    status = next;
    draft = draftOf(next);
    renderAll();
    publish(next);
  }

  async function load(): Promise<void> {
    const result = await probe();
    if (typeof result === 'string') {
      notify(gt('loadFailed'), { variant: 'danger' });
      return;
    }
    apply(result);
  }

  async function loadTokens(): Promise<void> {
    let tokens: GatewayToken[];
    try {
      tokens = await gatewayApi.tokens();
    } catch (error) {
      tokenList.replaceChildren(el('p', 'cs-gw-desc', gt('failed', { reason: errorText(error) })));
      return;
    }
    if (tokens.length === 0) {
      tokenList.replaceChildren(el('p', 'cs-gw-desc cs-gw-empty', gt('noTokens')));
      return;
    }
    tokenList.replaceChildren(
      ...tokens.map((token) => {
        const row = el('div', 'cs-set-row');
        const text = el('span', 'cs-set-text');
        const expires = token.expires ? gt('tokenExpires', { date: dateText(token.expires) }) : gt('tokenNever');
        text.append(el('span', 'cs-set-title', token.label), el('span', 'cs-set-sub', gt('tokenMeta', { created: dateText(token.created), expires })));
        const revoke = smallButton(
          gt('revoke'),
          () => {
            void confirmSheet(gt('revokeConfirm', { label: token.label }), gt('revoke'), gt('cancel'), true).then((ok) => {
              if (ok) void gatewayApi.revokeToken(token.label).then(loadTokens).catch(fail);
            });
          },
          'danger'
        );
        row.append(text, revoke);
        return row;
      })
    );
  }

  openSheet(gt('title'), page, { tall: true });
  if (status) renderAll();
  void load();
  void loadTokens();
}
