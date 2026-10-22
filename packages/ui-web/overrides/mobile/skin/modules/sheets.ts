/**
 * 半屏面板：网页版在手机上把 SFTP、常用命令、AI 助手做成铺满屏幕的抽屉，会挡住整个终端。
 * 这里把它们改成底部面板：
 * - 两档高度：半屏（约 58%，上方还能看到终端）与全屏；键盘弹出时自动全屏
 * - 拖动顶部把手或标题栏：上拉展开、下拉收起/关闭；点把手在两档之间切换；点面板外的遮罩关闭
 * - 每种面板记住上次的高度（默认都是半屏，上方留出终端）
 * - 只改外观与手势：开关仍由网页版自己的 show()/hide() 完成（关闭时点它自己的关闭按钮），状态、传输语义不变
 *
 * 面板打开与否从网页版写在面板上的内联样式判断：关闭时是 translateX(100%)（AI 助手还会 display:none）。
 */
import { Disposer, h } from '../dom';
import { st } from '../i18n';
import { closePanel, panelIsOpen } from '../panels';
import type { SkinModule } from '../types';
import './sheets.css';

type Kind = 'sftp' | 'snippet' | 'agent';
type Detent = 'half' | 'full';

const PANEL_SELECTOR = '#sftp-panel, #snippet-panel, #agent-panel';
const HEADER_SELECTOR = '.cs-ob-sheet-grabber, .sftp-panel-header, .agent-panel-header';
const DETENT_KEY = 'cloudssh_mobile_sheet_detents';
const DEFAULT_DETENTS: Record<Kind, Detent> = { sftp: 'half', snippet: 'half', agent: 'half' };
export const SHEET_STATE_EVENT = 'cloudssh:sheet-state';

const DRAG_SLOP = 8;

function loadDetents(): Record<Kind, Detent> {
  const detents = { ...DEFAULT_DETENTS };
  try {
    const saved = JSON.parse(localStorage.getItem(DETENT_KEY) ?? '{}') as Record<string, unknown>;
    for (const kind of Object.keys(detents) as Kind[]) {
      if (saved[kind] === 'half' || saved[kind] === 'full') detents[kind] = saved[kind];
    }
  } catch {
    // 用默认值
  }
  return detents;
}

function saveDetents(detents: Record<Kind, Detent>): void {
  try {
    localStorage.setItem(DETENT_KEY, JSON.stringify(detents));
  } catch {
    // 不记忆
  }
}

function kindOf(panel: HTMLElement): Kind | null {
  if (panel.id === 'sftp-panel') return 'sftp';
  if (panel.id === 'snippet-panel') return 'snippet';
  if (panel.id === 'agent-panel') return 'agent';
  return null;
}

interface Managed {
  kind: Kind;
  open: boolean;
  dispose: () => void;
}

export const sheetsModule: SkinModule = {
  id: 'sheets',
  mount() {
    const disposer = new Disposer();
    const detents = loadDetents();
    const managed = new Map<HTMLElement, Managed>();
    const scope = globalThis as { __cloudsshNoSnippetAutofocus?: boolean; __cloudsshNoAgentAutofocus?: boolean };
    // 打开命令面板、AI 助手时不自动聚焦输入框（手机上会立刻弹出键盘挡住面板），点输入框才弹键盘
    scope.__cloudsshNoSnippetAutofocus = true;
    scope.__cloudsshNoAgentAutofocus = true;
    disposer.add(() => {
      delete scope.__cloudsshNoSnippetAutofocus;
      delete scope.__cloudsshNoAgentAutofocus;
    });

    const backdrop = disposer.own(h('div', 'cs-ob-sheet-backdrop'));
    backdrop.setAttribute('aria-hidden', 'true');
    document.body.append(backdrop);

    const openPanels = () => [...managed.entries()].filter(([, item]) => item.open).map(([panel]) => panel);

    const zIndexOf = (panel: HTMLElement) => Number.parseInt(getComputedStyle(panel).zIndex, 10) || 0;

    /** 最上层的面板（z-index 最高）：遮罩点击与返回键都先关它 */
    const topPanel = () => openPanels().sort((a, b) => zIndexOf(b) - zIndexOf(a))[0] ?? null;

    const syncBackdrop = () => {
      const open = openPanels();
      // 遮罩紧贴在最上层面板的下面。各面板的层级沿用网页版（手机上 AI 助手 80、SFTP 90、命令 96），
      // 固定一个值总会有面板被遮罩盖住、点哪都变成“点遮罩关闭”
      const top = topPanel();
      if (top) backdrop.style.zIndex = String(zIndexOf(top) - 1);
      backdrop.classList.toggle('is-visible', open.length > 0);
      document.documentElement.classList.toggle('cs-sheet-open', open.length > 0);
    };

    disposer.listen(backdrop, 'click', () => {
      const panel = topPanel();
      if (panel) closePanel(panel);
    });

    const keyboardOpen = () => document.documentElement.classList.contains('mobile-keyboard-open');

    /** 实际显示的高度档位：键盘弹出时面板总是全屏（样式强制），与记住的档位无关 */
    const shownDetent = (panel: HTMLElement): Detent => (keyboardOpen() ? 'full' : (panel.dataset.csDetent as Detent));

    const setDetent = (panel: HTMLElement, kind: Kind, detent: Detent) => {
      panel.dataset.csDetent = detent;
      detents[kind] = detent;
      saveDetents(detents);
      // 键盘弹出时往半屏收：顺带收起键盘，面板才能真正变成半屏
      if (detent === 'half' && keyboardOpen() && document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)) {
        document.activeElement.blur();
      }
    };

    const sync = (panel: HTMLElement) => {
      const item = managed.get(panel);
      if (!item) return;
      const open = panelIsOpen(panel);
      if (open === item.open) return;
      item.open = open;
      if (open) panel.dataset.csDetent = detents[item.kind];
      panel.dataset.csOpen = open ? '1' : '0';
      panel.style.removeProperty('--cs-sheet-drag');
      syncBackdrop();
      window.dispatchEvent(new CustomEvent(SHEET_STATE_EVENT, { detail: { kind: item.kind, open } }));
    };

    const manage = (panel: HTMLElement) => {
      const kind = kindOf(panel);
      if (!kind || managed.has(panel)) return;
      const local = new Disposer();
      // 网页版新建的面板（连上服务器时、断线重连后都会重建 SFTP 与 AI 助手面板）停在屏幕右边外面。
      // 直接放到屏幕下方收起的位置、不要过渡动画：否则它会从右边斜着滑过屏幕右下角，闪一下
      panel.classList.add('is-placing', 'cs-ob-sheet');
      panel.dataset.csKind = kind;
      panel.dataset.csDetent = detents[kind];
      panel.dataset.csOpen = '0';
      void panel.getBoundingClientRect();
      requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.remove('is-placing')));

      const grabber = h('div', 'cs-ob-sheet-grabber');
      grabber.setAttribute('role', 'button');
      grabber.setAttribute('aria-label', st('sheetHandle'));
      grabber.title = st('sheetHandle');
      panel.prepend(grabber);
      local.add(() => grabber.remove());

      local.observe(panel, () => sync(panel), { attributes: true, attributeFilter: ['style'] });

      // ---- 拖动：只在把手与标题栏上生效，接管网页版在标题栏上的横向右滑关闭 ----
      let drag: { y: number; x: number; time: number; lastY: number; lastTime: number; velocity: number; active: boolean; height: number } | null = null;

      const inHeader = (event: TouchEvent) => {
        const target = event.target as Element | null;
        const header = target?.closest(HEADER_SELECTOR);
        return !!header && panel.contains(header);
      };

      local.listen(
        panel,
        'touchstart',
        (event) => {
          const touchEvent = event as TouchEvent;
          if (!managed.get(panel)?.open || touchEvent.touches.length !== 1 || !inHeader(touchEvent)) {
            drag = null;
            return;
          }
          // 网页版的横向右滑关闭在面板上监听冒泡阶段，这里在捕获阶段截住，避免两套手势互相干扰
          event.stopPropagation();
          const touch = touchEvent.touches[0];
          drag = {
            x: touch.clientX,
            y: touch.clientY,
            time: event.timeStamp,
            lastY: touch.clientY,
            lastTime: event.timeStamp,
            velocity: 0,
            active: false,
            height: panel.getBoundingClientRect().height,
          };
        },
        { capture: true, passive: true }
      );

      local.listen(
        panel,
        'touchmove',
        (event) => {
          if (!drag) return;
          event.stopPropagation();
          const touch = (event as TouchEvent).touches[0];
          if (!touch) return;
          const dy = touch.clientY - drag.y;
          const dx = touch.clientX - drag.x;
          if (!drag.active) {
            if (Math.abs(dy) > DRAG_SLOP && Math.abs(dy) > Math.abs(dx)) {
              drag.active = true;
              panel.classList.add('is-dragging');
            } else if (Math.abs(dx) > DRAG_SLOP * 2) {
              drag = null;
              return;
            } else return;
          }
          event.preventDefault();
          const dt = event.timeStamp - drag.lastTime;
          if (dt > 0) drag.velocity = drag.velocity * 0.6 + ((touch.clientY - drag.lastY) / dt) * 0.4;
          drag.lastY = touch.clientY;
          drag.lastTime = event.timeStamp;
          // 往下跟手；往上有阻尼（半屏时给出“可以再拉高”的反馈，全屏时只轻微回弹）
          const detent = shownDetent(panel);
          const offset = dy >= 0 ? dy : detent === 'half' ? dy * 0.35 : -Math.min(18, Math.sqrt(-dy) * 2);
          panel.style.setProperty('--cs-sheet-drag', `${offset}px`);
        },
        { capture: true, passive: false }
      );

      const finish = (event: Event) => {
        if (!drag) return;
        event.stopPropagation();
        const current = drag;
        drag = null;
        if (!current.active) {
          // 点按把手：两档之间切换
          if ((event.target as Element | null)?.closest('.cs-ob-sheet-grabber') && event.type === 'touchend') {
            setDetent(panel, kind, shownDetent(panel) === 'full' ? 'half' : 'full');
          }
          return;
        }
        panel.classList.remove('is-dragging');
        const touch = (event as TouchEvent).changedTouches[0];
        const dy = (touch ? touch.clientY : current.lastY) - current.y;
        const velocity = current.velocity;
        const detent = shownDetent(panel);
        let next: Detent | 'close' = detent;
        if (event.type !== 'touchcancel') {
          if (detent === 'full') {
            if (dy > current.height * 0.55 || (velocity > 1.4 && dy > 80)) next = 'close';
            else if (dy > 90 || (velocity > 0.45 && dy > 30)) next = 'half';
          } else if (dy > 70 || (velocity > 0.45 && dy > 24)) next = 'close';
          else if (dy < -40 || (velocity < -0.45 && dy < -16)) next = 'full';
        }
        if (next === 'close') {
          closePanel(panel);
          return;
        }
        panel.style.removeProperty('--cs-sheet-drag');
        if (next !== detent) setDetent(panel, kind, next);
      };
      local.listen(panel, 'touchend', finish, { capture: true });
      local.listen(panel, 'touchcancel', finish, { capture: true });

      local.add(() => {
        panel.classList.remove('cs-ob-sheet', 'is-dragging');
        delete panel.dataset.csKind;
        delete panel.dataset.csDetent;
        delete panel.dataset.csOpen;
        panel.style.removeProperty('--cs-sheet-drag');
      });

      managed.set(panel, { kind, open: false, dispose: () => local.run() });
      sync(panel);
    };

    const unmanage = (panel: HTMLElement) => {
      const item = managed.get(panel);
      if (!item) return;
      managed.delete(panel);
      item.dispose();
      syncBackdrop();
    };

    for (const panel of document.querySelectorAll<HTMLElement>(PANEL_SELECTOR)) manage(panel);
    disposer.observe(
      document.body,
      (records) => {
        for (const record of records) {
          for (const node of record.addedNodes) if (node instanceof HTMLElement && node.matches(PANEL_SELECTOR)) manage(node);
          for (const node of record.removedNodes) if (node instanceof HTMLElement) unmanage(node);
        }
      },
      { childList: true }
    );

    disposer.add(() => {
      for (const panel of [...managed.keys()]) unmanage(panel);
      document.documentElement.classList.remove('cs-sheet-open');
    });

    return () => disposer.run();
  },
};
