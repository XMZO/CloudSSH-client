/**
 * 电脑端“同步到手机”：勾选要传的内容（分组与排序、凭据预设）→ 加密后切成多张二维码循环播放，
 * 旁边显示本次的 6 位验证码。手机 App 扫齐后输入验证码、确认再导入（协议见 shared/qr-sync/protocol.ts）。
 * 关闭窗口后二维码与验证码即作废（只存在内存里）。
 */
import qrcode from 'qrcode-generator';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import { exportPresets, listPresets, presetsAvailable } from '../shared/credential-presets';
import { qt, sortLabel } from '../shared/qr-sync/i18n';
import { CHUNK_CHARS, formatCode, newCode, sealPayload, type SyncOrder, type SyncPayload, toFrames } from '../shared/qr-sync/protocol';
import { el, icon, iconButton } from './dom';
import './qr-sync.css';

/** 侧栏保存的排序（sidebar.ts 的 KEYS） */
const KEYS = {
  order: 'cloudssh_desktop_node_order',
  sort: 'cloudssh_desktop_sidebar_sort',
  collapsed: 'cloudssh_desktop_sidebar_collapsed_groups',
};
const FRAME_MS = 300;
const QR_PIXELS = 288;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function currentOrder(): SyncOrder {
  const order = readJson<{ groups?: unknown; servers?: unknown }>(KEYS.order, {});
  const groups = Array.isArray(order.groups) ? order.groups.filter((key): key is string => typeof key === 'string') : [];
  const servers: Record<string, number[]> = {};
  if (order.servers && typeof order.servers === 'object') {
    for (const [key, ids] of Object.entries(order.servers as Record<string, unknown>)) {
      if (Array.isArray(ids)) servers[key] = ids.filter((id): id is number => Number.isSafeInteger(id));
    }
  }
  const sort = readJson<string>(KEYS.sort, 'name');
  const collapsed = readJson<unknown>(KEYS.collapsed, []);
  return {
    groups,
    servers,
    sort: ['name', 'count', 'recent', 'custom'].includes(sort) ? sort : 'name',
    collapsed: Array.isArray(collapsed) ? collapsed.filter((key): key is string => typeof key === 'string') : [],
  };
}

function orderSummary(order: SyncOrder): string {
  const servers = Object.values(order.servers).reduce((sum, ids) => sum + ids.length, 0);
  if (!order.groups.length && !servers) return qt('orderEmpty', { sort: sortLabel(order.sort) });
  return qt('orderDetail', { groups: order.groups.length, servers, sort: sortLabel(order.sort), collapsed: order.collapsed.length });
}

async function currentUserId(): Promise<number | null> {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!response.ok) return null;
    const user = (await response.json()) as { github_id?: unknown; id?: unknown };
    const id = typeof user.github_id === 'number' ? user.github_id : user.id;
    return typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}

/** 画一张二维码：白底黑块，四周留 4 格静区（屏幕再暗的主题也好扫） */
function drawQr(canvas: HTMLCanvasElement, text: string): void {
  const qr = qrcode(0, 'L');
  qr.addData(text, 'Alphanumeric');
  qr.make();
  const count = qr.getModuleCount();
  const cell = Math.max(2, Math.floor(QR_PIXELS / (count + 8)));
  const size = cell * (count + 8);
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(size * ratio);
  canvas.height = Math.round(size * ratio);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) ctx.fillRect((col + 4) * cell, (row + 4) * cell, cell, cell);
    }
  }
}

let openRoot: HTMLElement | null = null;
let stopTimer: (() => void) | null = null;

export function closeQrSync(): void {
  stopTimer?.();
  stopTimer = null;
  openRoot?.remove();
  openRoot = null;
}

export async function openQrSync(): Promise<void> {
  closeQrSync();
  const root = el('div', 'cs-qs-root');
  const dialog = el('div', 'cs-qs-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', qt('title'));
  dialog.tabIndex = -1;
  const head = el('div', 'cs-qs-head');
  head.append(icon('qr_code_2'), el('h2', 'cs-qs-title', qt('title')));
  const close = iconButton('close', qt('close'), 'cs-qs-iconbtn');
  close.addEventListener('click', closeQrSync);
  head.append(close);
  const body = el('div', 'cs-qs-body');
  const foot = el('div', 'cs-qs-foot');
  dialog.append(head, body, foot);
  root.append(dialog);
  document.body.append(root);
  openRoot = root;
  root.addEventListener('pointerdown', (event) => {
    if (event.target === root) closeQrSync();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    closeQrSync();
  });

  const order = currentOrder();
  const vaultOk = await presetsAvailable();
  const presets = vaultOk ? await listPresets() : [];
  const picked = { order: true, presets: presets.length > 0 };

  // ---------- 第一步：勾选 ----------
  const showPick = () => {
    stopTimer?.();
    stopTimer = null;
    body.replaceChildren();
    foot.replaceChildren();
    body.append(el('p', 'cs-qs-intro', qt('intro')));
    const option = (key: 'order' | 'presets', title: string, lines: string[], enabled: boolean) => {
      const row = el('label', `cs-qs-option${enabled ? '' : ' is-disabled'}`);
      const box = el('input');
      box.type = 'checkbox';
      box.checked = enabled && picked[key];
      box.disabled = !enabled;
      box.addEventListener('change', () => {
        picked[key] = box.checked;
        generate.disabled = !picked.order && !picked.presets;
      });
      const text = el('span', 'cs-qs-option-text');
      text.append(el('span', 'cs-qs-option-title', title));
      for (const line of lines) text.append(el('span', 'cs-qs-option-detail', line));
      row.append(box, text);
      return row;
    };
    const names = presets.slice(0, 4).map((preset) => preset.name).join(qt('listSep')) + (presets.length > 4 ? '…' : '');
    body.append(
      option('order', qt('orderTitle'), [orderSummary(order)], true),
      option(
        'presets',
        qt('presetsTitle'),
        !vaultOk ? [qt('presetsUnavailable')] : presets.length ? [qt('presetsDetail', { n: presets.length, names }), qt('presetsSecret')] : [qt('presetsNone')],
        vaultOk && presets.length > 0
      )
    );
    const generate = el('button', 'cs-qs-btn is-primary');
    generate.type = 'button';
    generate.append(icon('qr_code_2'), el('span', '', qt('generate')));
    generate.disabled = !picked.order && !picked.presets;
    generate.addEventListener('click', async () => {
      if (!picked.order && !picked.presets) {
        notify(qt('nothingPicked'), { variant: 'warning' });
        return;
      }
      generate.disabled = true;
      generate.lastElementChild!.textContent = qt('generating');
      try {
        await showCodes();
      } catch (error) {
        notify(qt('failed', { reason: error instanceof Error ? error.message : String(error) }), { variant: 'danger' });
        generate.disabled = false;
        generate.lastElementChild!.textContent = qt('generate');
      }
    });
    foot.append(generate);
  };

  // ---------- 第二步：轮播二维码 ----------
  const showCodes = async () => {
    const info = await window.cloudsshDesktop?.info().catch(() => null);
    const payload: SyncPayload = {
      v: 1,
      createdAt: Date.now(),
      source: { origin: location.origin, userId: await currentUserId(), name: info?.instance.name ?? location.host },
    };
    if (picked.order) payload.order = currentOrder();
    if (picked.presets) payload.presets = await exportPresets();
    const code = newCode();
    const sealed = await sealPayload(payload, code);
    const frames = toFrames(sealed);
    if (!frames) throw new Error(qt('tooMany', { n: Math.ceil(sealed.length / CHUNK_CHARS) }));
    if (openRoot !== root) return;
    body.replaceChildren();
    foot.replaceChildren();

    const layout = el('div', 'cs-qs-show');
    const left = el('div', 'cs-qs-qr');
    const canvas = el('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', qt('title'));
    const counter = el('div', 'cs-qs-counter');
    left.append(canvas, counter);
    const right = el('div', 'cs-qs-side');
    const codeBox = el('div', 'cs-qs-code');
    codeBox.append(el('span', 'cs-qs-code-label', qt('codeLabel')), el('span', 'cs-qs-code-value', formatCode(code)));
    const steps = el('ol', 'cs-qs-steps');
    for (const step of [qt('step1'), qt('step2', { n: frames.length }), qt('step3')]) steps.append(el('li', '', step));
    right.append(codeBox, steps, el('p', 'cs-qs-warn', qt('warn')));
    layout.append(left, right);
    body.append(layout);

    let index = 0;
    const paint = () => {
      drawQr(canvas, frames[index]);
      counter.textContent = frames.length > 1 ? qt('frameOf', { i: index + 1, n: frames.length }) : qt('frameSingle');
    };
    paint();
    if (frames.length > 1) {
      const timer = window.setInterval(() => {
        index = (index + 1) % frames.length;
        paint();
      }, FRAME_MS);
      stopTimer = () => window.clearInterval(timer);
    }

    const back = el('button', 'cs-qs-btn');
    back.type = 'button';
    back.textContent = qt('back');
    back.addEventListener('click', showPick);
    const again = el('button', 'cs-qs-btn');
    again.type = 'button';
    again.append(icon('refresh'), el('span', '', qt('regenerate')));
    again.addEventListener('click', () => {
      stopTimer?.();
      stopTimer = null;
      void showCodes().catch((error: unknown) => notify(qt('failed', { reason: error instanceof Error ? error.message : String(error) }), { variant: 'danger' }));
    });
    const done = el('button', 'cs-qs-btn is-primary');
    done.type = 'button';
    done.textContent = qt('done');
    done.addEventListener('click', closeQrSync);
    foot.append(back, el('span', 'cs-qs-spacer'), again, done);
  };

  showPick();
  dialog.focus();
}
