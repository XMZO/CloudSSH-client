/**
 * 手机端“从电脑同步”：用相机扫电脑上轮播的二维码 → 收齐后输入电脑上显示的验证码 → 解密 → 确认导入。
 *   - 识别：系统有 BarcodeDetector 就用它（快），没有就用内置的 jsQR（纯 JavaScript，不依赖谷歌服务）
 *   - 分组排序：只有电脑和手机登录的是同一个实例、同一个账号时才能导入（服务器 id 只在那个账号里有效）
 *   - 凭据预设：密码 / 私钥用手机的 Keystore 重新加密保存；不同账号时只导入预设本身，不导入和服务器的对应关系
 *   - 命令片段顺序：同样只有同一个实例、同一个账号时才能导入（片段 id 只在那个账号里有效）
 * 协议与加密见 shared/qr-sync/protocol.ts。
 */
import jsQR from 'jsqr';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import { importPresets, presetIds, presetsAvailable } from '../shared/credential-presets';
import { replaceCloudSnippetOrder } from '../shared/snippet-order';
import { qt, sortLabel } from '../shared/qr-sync/i18n';
import { FrameCollector, normalizeCode, openPayload, type SyncPayload, WrongCodeError } from '../shared/qr-sync/protocol';
import { nodeOrder, type NodeSortMode, notifyOrderChanged, setNodeSortMode } from './node-groups';
import { replaceCollapsedGroups } from './nodes';
import { el, icon } from './sheet';
import { native } from './tauri';
import './qr-sync.css';

type Detect = (canvas: HTMLCanvasElement) => Promise<string[]>;

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

async function makeDetector(): Promise<Detect> {
  const Native = (window as unknown as { BarcodeDetector?: { new (options: { formats: string[] }): BarcodeDetectorLike; getSupportedFormats(): Promise<string[]> } })
    .BarcodeDetector;
  if (Native) {
    try {
      if ((await Native.getSupportedFormats()).includes('qr_code')) {
        const detector = new Native({ formats: ['qr_code'] });
        return async (canvas) => (await detector.detect(canvas)).map((code) => code.rawValue);
      }
    } catch {
      // 退回 jsQR
    }
  }
  return async (canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
    return code ? [code.data] : [];
  };
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

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let openRoot: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

export function closeQrScanner(): void {
  cleanup?.();
  cleanup = null;
  openRoot?.remove();
  openRoot = null;
}

export function openQrScanner(): void {
  closeQrScanner();
  const root = el('div', 'cs-qsm-root');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', qt('scanTitle'));
  root.tabIndex = -1;
  const head = el('div', 'cs-qsm-head');
  const close = el('button', 'cs-qsm-close');
  close.type = 'button';
  close.setAttribute('aria-label', qt('close'));
  close.append(icon('close'));
  close.addEventListener('click', closeQrScanner);
  head.append(el('div', 'cs-qsm-title', qt('scanTitle')), close);
  const stage = el('div', 'cs-qsm-stage');
  root.append(head, stage);
  document.body.append(root);
  openRoot = root;
  root.focus();
  // 返回键：网页版的返回处理会给最上层的对话框派发 Esc
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeQrScanner();
  });

  const collector = new FrameCollector();
  void startScanning(root, stage, collector);
}

// ---------- 扫码 ----------

async function startScanning(root: HTMLElement, stage: HTMLElement, collector: FrameCollector): Promise<void> {
  stage.replaceChildren();
  const video = el('video', 'cs-qsm-video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  const guide = el('div', 'cs-qsm-guide');
  const panel = el('div', 'cs-qsm-panel');
  const status = el('div', 'cs-qsm-status', qt('scanStarting'));
  const bar = el('div', 'cs-qsm-bar');
  const fill = el('div', 'cs-qsm-fill');
  bar.append(fill);
  const dots = el('div', 'cs-qsm-dots');
  panel.append(status, bar, dots);
  stage.append(video, guide, panel);

  let stream: MediaStream | null = null;
  let running = true;
  let timer = 0;
  const stop = () => {
    running = false;
    window.clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    document.removeEventListener('visibilitychange', onVisibility);
  };
  // 切到后台时相机会被系统停掉：回来后重新打开
  const onVisibility = () => {
    if (document.visibilityState !== 'visible' || openRoot !== root || collector.complete) return;
    stop();
    void startScanning(root, stage, collector);
  };
  document.addEventListener('visibilitychange', onVisibility);
  cleanup = stop;

  const renderProgress = () => {
    const total = collector.expected;
    if (!total) {
      status.textContent = qt('scanHint');
      fill.style.width = '0%';
      dots.replaceChildren();
      return;
    }
    status.textContent = qt('scanProgress', { got: collector.received, total });
    fill.style.width = `${(collector.received / total) * 100}%`;
    if (total <= 40) {
      dots.replaceChildren(
        ...Array.from({ length: total }, (_, i) => {
          const dot = el('span', 'cs-qsm-dot');
          if (collector.has(i + 1)) dot.classList.add('is-on');
          return dot;
        })
      );
    } else {
      dots.replaceChildren();
    }
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (error) {
    if (openRoot !== root) return;
    stop();
    const name = (error as { name?: string })?.name;
    showCameraError(
      root,
      stage,
      collector,
      name === 'NotAllowedError' || name === 'SecurityError'
        ? qt('cameraDenied')
        : name === 'NotFoundError' || name === 'OverconstrainedError'
          ? qt('cameraMissing')
          : qt('cameraFailed', { reason: errorText(error) })
    );
    return;
  }
  if (openRoot !== root || !running) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    // 有的 WebView 需要等元数据，下面的循环会等 readyState
  }
  renderProgress();

  const detect = await makeDetector();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const tick = async () => {
    if (!running) return;
    if (video.readyState >= 2 && video.videoWidth) {
      // 只取画面中间的正方形（取景框），缩到 720 以内，识别更快
      const side = Math.min(video.videoWidth, video.videoHeight) * 0.9;
      const size = Math.round(Math.min(720, side));
      canvas.width = canvas.height = size;
      ctx.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, size, size);
      try {
        for (const text of await detect(canvas)) {
          if (collector.add(text)) {
            guide.classList.remove('is-hit');
            void guide.offsetWidth;
            guide.classList.add('is-hit');
            navigator.vibrate?.(15);
          }
        }
      } catch {
        // 单帧识别失败不影响下一帧
      }
      renderProgress();
      if (collector.complete) {
        stop();
        showCodeStep(root, stage, collector);
        return;
      }
    }
    timer = window.setTimeout(() => void tick(), 50);
  };
  void tick();
}

function showCameraError(root: HTMLElement, stage: HTMLElement, collector: FrameCollector, message: string): void {
  stage.replaceChildren();
  const box = el('div', 'cs-qsm-card');
  box.append(icon('no_photography'), el('p', 'cs-qsm-message', message));
  const retry = el('button', 'cs-qsm-btn is-primary', qt('retry'));
  retry.type = 'button';
  retry.addEventListener('click', () => void startScanning(root, stage, collector));
  box.append(retry);
  stage.append(box);
}

// ---------- 验证码 ----------

function showCodeStep(root: HTMLElement, stage: HTMLElement, collector: FrameCollector): void {
  stage.replaceChildren();
  const card = el('div', 'cs-qsm-card');
  card.append(icon('lock'), el('p', 'cs-qsm-heading', qt('codeTitle')));
  const input = el('input', 'cs-qsm-code');
  input.type = 'text';
  input.inputMode = 'text';
  input.autocomplete = 'off';
  input.autocapitalize = 'characters';
  input.spellcheck = false;
  input.maxLength = 7;
  input.placeholder = qt('codePlaceholder');
  input.setAttribute('aria-label', qt('codeLabel'));
  const error = el('p', 'cs-qsm-error');
  error.hidden = true;
  const ok = el('button', 'cs-qsm-btn is-primary', qt('confirm'));
  ok.type = 'button';
  const rescan = el('button', 'cs-qsm-btn', qt('rescan'));
  rescan.type = 'button';
  rescan.addEventListener('click', () => void startScanning(root, stage, new FrameCollector()));
  const actions = el('div', 'cs-qsm-actions');
  actions.append(rescan, ok);
  card.append(input, error, actions);
  stage.append(card);
  setTimeout(() => input.focus(), 50);

  const fail = (message: string) => {
    error.textContent = message;
    error.hidden = false;
    ok.disabled = false;
    ok.textContent = qt('confirm');
  };
  const submit = async () => {
    const code = normalizeCode(input.value);
    if (!code) {
      fail(qt('codeInvalid'));
      return;
    }
    ok.disabled = true;
    ok.textContent = qt('codeChecking');
    error.hidden = true;
    try {
      const payload = await openPayload(collector.text(), code);
      if (openRoot !== root) return;
      input.blur();
      await showPreview(root, stage, payload);
    } catch (problem) {
      if (problem instanceof WrongCodeError) fail(qt('codeWrong'));
      else if (errorText(problem) === 'unsupported') fail(qt('unsupported'));
      else fail(qt('importFailed', { reason: errorText(problem) }));
    }
  };
  ok.addEventListener('click', () => void submit());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
  });
}

// ---------- 确认导入 ----------

async function showPreview(root: HTMLElement, stage: HTMLElement, payload: SyncPayload): Promise<void> {
  const [state, userId, vaultOk, existing] = await Promise.all([native.state().catch(() => null), currentUserId(), presetsAvailable(), presetIds()]);
  if (openRoot !== root) return;
  let phoneOrigin = '';
  try {
    phoneOrigin = state ? new URL(state.current.baseUrl).origin : '';
  } catch {
    phoneOrigin = '';
  }
  const sameAccount = phoneOrigin === payload.source.origin && userId === payload.source.userId;

  stage.replaceChildren();
  const card = el('div', 'cs-qsm-card is-wide');
  card.append(el('p', 'cs-qsm-heading', qt('previewTitle')));
  card.append(el('p', 'cs-qsm-source', qt('previewSource', { name: payload.source.name, host: hostOf(payload.source.origin) })));
  const picked = { order: false, presets: false, snippets: false };
  const nothingPicked = () => !picked.order && !picked.presets && !picked.snippets;
  const option = (key: keyof typeof picked, title: string, lines: string[], enabled: boolean) => {
    const row = el('label', `cs-qsm-option${enabled ? '' : ' is-disabled'}`);
    const box = el('input');
    box.type = 'checkbox';
    box.checked = enabled;
    box.disabled = !enabled;
    picked[key] = enabled;
    box.addEventListener('change', () => {
      picked[key] = box.checked;
      go.disabled = nothingPicked();
    });
    const text = el('span', 'cs-qsm-option-text');
    text.append(el('span', 'cs-qsm-option-title', title));
    for (const line of lines) text.append(el('span', 'cs-qsm-option-detail', line));
    row.append(box, text);
    return row;
  };

  const go = el('button', 'cs-qsm-btn is-primary', qt('import'));
  go.type = 'button';
  if (payload.order) {
    const order = payload.order;
    const servers = Object.values(order.servers).reduce((sum, ids) => sum + ids.length, 0);
    card.append(
      option(
        'order',
        qt('orderTitle'),
        [sameAccount ? qt('orderImport', { groups: order.groups.length, servers, sort: sortLabel(order.sort) }) : qt('orderMismatch')],
        sameAccount
      )
    );
  }
  if (payload.presets) {
    const items = payload.presets.items;
    const updated = items.filter((item) => existing.has(item.id)).length;
    const lines = vaultOk
      ? [qt('presetsImport', { n: items.length, added: items.length - updated, updated }), items.map((item) => item.name).join(qt('listSep'))]
      : [qt('presetsVaultMissing')];
    if (vaultOk && !sameAccount) lines.push(qt('presetsLinksDropped'));
    card.append(option('presets', qt('presetsTitle'), lines, vaultOk && items.length > 0));
  }
  // 命令片段顺序：片段 id 只在同一个实例的同一个账号里对得上
  if (payload.snippets?.order?.length) {
    card.append(option('snippets', qt('snippetsTitle'), [qt(sameAccount ? 'snippetsImport' : 'snippetsMismatch')], sameAccount));
  }
  // 只说明这次真的会替换 / 覆盖的部分
  const notes: string[] = [];
  if (picked.order) notes.push(qt('replaceOrderNote'));
  if (picked.presets && payload.presets?.items.some((item) => existing.has(item.id))) notes.push(qt('replacePresetsNote'));
  if (picked.snippets) notes.push(qt('replaceSnippetsNote'));
  if (notes.length) card.append(el('p', 'cs-qsm-note', notes.join(qt('partSep'))));
  go.disabled = nothingPicked();
  const cancel = el('button', 'cs-qsm-btn', qt('cancel'));
  cancel.type = 'button';
  cancel.addEventListener('click', closeQrScanner);
  const actions = el('div', 'cs-qsm-actions');
  actions.append(cancel, go);
  card.append(actions);
  stage.append(card);

  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const parts: string[] = [];
      if (picked.order && payload.order) {
        const order = payload.order;
        nodeOrder().replace({ groups: order.groups, servers: order.servers });
        replaceCollapsedGroups(order.collapsed);
        const mode: Record<string, NodeSortMode> = { custom: 'custom', name: 'name', recent: 'recent' };
        if (mode[order.sort]) setNodeSortMode(mode[order.sort]);
        else notifyOrderChanged();
        parts.push(qt('importedOrder'));
      }
      if (picked.presets && payload.presets) {
        const result = await importPresets(payload.presets.items, sameAccount ? payload.presets.links : null);
        parts.push(qt('importedPresets', result));
      }
      if (picked.snippets && payload.snippets) {
        replaceCloudSnippetOrder(payload.snippets.order);
        parts.push(qt('importedSnippets'));
      }
      closeQrScanner();
      notify(parts.join(qt('partSep')), { title: qt('imported'), variant: 'success' });
    } catch (error) {
      go.disabled = false;
      notify(qt('importFailed', { reason: errorText(error) }), { variant: 'danger' });
    }
  });
}
