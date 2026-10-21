/**
 * 快捷命令条：键盘上方一排常用命令（就是“自定义命令”里保存的那些：登录时云端同步，匿名时存在本机）。
 * - 点一下：填入终端（不回车）；命令里有 {{参数}} 时先弹出参数表单
 * - 长按：填入 / 填入并执行 / 复制 / 管理
 * - 按键栏最左侧的 ⚡ 显示或收起这一排，选择会被记住
 * 顺序与命令面板里拖动排好的一致（../../../shared/snippet-order.ts）。
 * 分享会话里网页版会隐藏命令入口，这里跟着隐藏。命令面板关闭（可能增删改过）后自动刷新。
 */
import { copyTextToClipboard } from '../../../../upstream/frontend/src/clipboard';
import { LocalSnippetStore, RemoteSnippetStore, type CommandSnippet } from '../../../../upstream/frontend/src/snippet-store';
import { extractSnippetVariables, resolveSnippetVariables } from '../../../../upstream/frontend/src/snippet-variables';
import { notify } from '../../../../upstream/frontend/src/ui-feedback';
import { SNIPPET_ORDER_EVENT, sortSnippets } from '../../../shared/snippet-order';
import { activeTab } from '../../../sidebar/hooks';
import { getServers, subscribe } from '../../../sidebar/store';
import { closeSheet, openSheet, showActions } from '../../sheet';
import { clickById, Disposer, h, icon, requestTerminalRefit, upstreamButtonAvailable } from '../dom';
import { onLocaleChange, st } from '../i18n';
import { watchPanel } from '../panels';
import type { SkinModule } from '../types';
import './commands.css';

const VISIBLE_KEY = 'cloudssh_mobile_quick_commands';

function loadVisible(): boolean {
  try {
    return localStorage.getItem(VISIBLE_KEY) !== '0';
  } catch {
    return true;
  }
}

function saveVisible(visible: boolean): void {
  try {
    localStorage.setItem(VISIBLE_KEY, visible ? '1' : '0');
  } catch {
    // 不记忆
  }
}

/** 逐个填写 {{参数}}；取消返回 null */
function promptVariables(names: string[], title: string): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    let done = false;
    const form = h('form', 'cs-ob-vars');
    const inputs = names.map((name) => {
      const label = h('label', 'cs-m-field');
      const input = h('input', 'cs-m-input');
      input.name = name;
      input.placeholder = name;
      input.autocomplete = 'off';
      input.autocapitalize = 'off';
      input.spellcheck = false;
      label.append(h('span', 'cs-m-field-label', name), input);
      form.append(label);
      return input;
    });
    const actions = h('div', 'cs-m-row');
    const cancel = h('button', 'cs-m-btn', st('cancel'));
    cancel.type = 'button';
    const ok = h('button', 'cs-m-btn is-primary', st('cmdVarsOk'));
    ok.type = 'submit';
    actions.append(cancel, ok);
    form.append(actions);
    cancel.addEventListener('click', () => closeSheet());
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      done = true;
      const values = Object.fromEntries(inputs.map((input) => [input.name, input.value]));
      closeSheet();
      resolve(values);
    });
    openSheet(`${st('cmdVarsTitle')} · ${title}`, form, { onClose: () => !done && resolve(null) });
    requestAnimationFrame(() => inputs[0]?.focus());
  });
}

async function insertCommand(snippet: CommandSnippet, run: boolean): Promise<void> {
  let command = snippet.command;
  const names = extractSnippetVariables(command);
  if (names.length) {
    const values = await promptVariables(names, snippet.name);
    if (!values) return;
    command = resolveSnippetVariables(command, values);
  }
  const terminal = activeTab()?.terminal;
  if (!terminal?.insertSnippet || !terminal.insertSnippet(command, run)) {
    notify(st('cmdInsertFailed'), { variant: 'warning' });
  }
}

export const commandsModule: SkinModule = {
  id: 'commands',
  mount() {
    const disposer = new Disposer();
    const toolbar = document.getElementById('mobile-terminal-toolbar');
    if (!toolbar) return () => disposer.run();
    const root = document.documentElement;

    let visible = loadVisible();
    let snippets: CommandSnippet[] = [];
    let status: 'loading' | 'ready' | 'error' = 'loading';
    let loadToken = 0;
    /** 登录后服务器列表才会加载出来：以此区分云端命令与本机命令 */
    const authenticated = () => getServers() !== null;
    let loadedAuthenticated: boolean | null = null;
    const terminalVisible = () => !document.getElementById('terminal-section')?.classList.contains('hidden');

    const row = disposer.own(h('div', 'cs-ob-cmds'));
    row.setAttribute('role', 'toolbar');
    const scroller = h('div', 'cs-ob-cmds-scroll');
    row.append(scroller);
    toolbar.before(row);

    const toggle = disposer.own(h('button', 'cs-ob-cmds-toggle'));
    toggle.type = 'button';
    toggle.append(icon('bolt'));
    toolbar.prepend(toggle);

    const allowed = () => upstreamButtonAvailable('mobile-snippets-btn');

    const applyVisibility = () => {
      const show = visible && allowed();
      const before = root.dataset.csCmds === 'on';
      if (show) root.dataset.csCmds = 'on';
      else delete root.dataset.csCmds;
      toggle.hidden = !allowed();
      toggle.classList.toggle('is-on', visible);
      toggle.setAttribute('aria-pressed', String(visible));
      toggle.setAttribute('aria-label', st('cmdToggle'));
      toggle.title = st('cmdToggle');
      if (before !== show) requestTerminalRefit();
    };
    disposer.add(() => {
      delete root.dataset.csCmds;
      requestTerminalRefit();
    });

    const chip = (label: string, className = '') => {
      const button = h('button', `cs-ob-chip ${className}`.trim());
      button.type = 'button';
      button.append(h('span', 'cs-ob-chip-text', label));
      return button;
    };

    const render = () => {
      const manage = chip(st('cmdManage'), 'is-manage');
      manage.prepend(icon('edit_note'));
      manage.addEventListener('click', () => clickById('mobile-snippets-btn'));
      const items: HTMLElement[] = [manage];
      if (status === 'error') {
        const retry = chip(st('cmdLoadFailed'), 'is-hint');
        retry.addEventListener('click', () => void load());
        items.push(retry);
      } else if (status === 'ready' && !snippets.length) {
        const empty = chip(st('cmdEmpty'), 'is-hint');
        empty.addEventListener('click', () => clickById('mobile-snippets-btn'));
        items.push(empty);
      }
      for (const snippet of snippets) {
        const button = chip(snippet.name);
        button.dataset.id = snippet.id;
        button.title = snippet.command;
        items.push(button);
      }
      scroller.replaceChildren(...items);
    };

    async function load(): Promise<void> {
      const token = ++loadToken;
      if (!snippets.length) {
        status = 'loading';
        render();
      }
      const remote = authenticated();
      try {
        const store = remote ? new RemoteSnippetStore() : new LocalSnippetStore();
        const list = await store.list();
        if (token !== loadToken) return;
        snippets = sortSnippets(list, remote);
        status = 'ready';
        loadedAuthenticated = remote;
      } catch {
        if (token !== loadToken) return;
        status = snippets.length ? 'ready' : 'error';
      }
      render();
    }

    // 点按填入；长按（系统的 contextmenu）弹出更多操作
    let longPressed = false;
    const snippetOf = (target: EventTarget | null) => {
      const id = (target as Element | null)?.closest<HTMLElement>('.cs-ob-chip[data-id]')?.dataset.id;
      return id ? snippets.find((item) => item.id === id) ?? null : null;
    };
    disposer.listen(scroller, 'pointerdown', () => (longPressed = false));
    disposer.listen(scroller, 'contextmenu', (event) => {
      const snippet = snippetOf(event.target);
      if (!snippet) return;
      event.preventDefault();
      longPressed = true;
      showActions(
        snippet.name,
        [
          { label: st('cmdInsert'), icon: 'keyboard', action: () => void insertCommand(snippet, false) },
          { label: st('cmdInsertRun'), icon: 'play_arrow', action: () => void insertCommand(snippet, true) },
          {
            label: st('cmdCopy'),
            icon: 'content_copy',
            action: () =>
              void copyTextToClipboard(snippet.command).then((ok) => ok && notify(st('cmdCopied'), { variant: 'success', duration: 1500 })),
          },
          { label: st('cmdManage'), icon: 'edit_note', action: () => clickById('mobile-snippets-btn') },
        ],
        st('cancel')
      );
    });
    disposer.listen(scroller, 'click', (event) => {
      if (longPressed) {
        longPressed = false;
        return;
      }
      const snippet = snippetOf(event.target);
      if (snippet) void insertCommand(snippet, false);
    });

    // 在命令面板里拖动调整了顺序（或扫码导入了电脑上的顺序）：按新顺序重排
    disposer.listen(window, SNIPPET_ORDER_EVENT, () => {
      if (loadedAuthenticated === null) return;
      snippets = sortSnippets(snippets, loadedAuthenticated);
      render();
    });

    disposer.listen(toggle, 'click', () => {
      visible = !visible;
      saveVisible(visible);
      applyVisibility();
      if (visible) void load();
    });

    // 命令面板关闭后（可能增删改过命令）刷新；分享会话等场景网页版隐藏入口时跟随
    disposer.add(watchPanel('snippet-panel', (open) => !open && void load()));
    const snippetsButton = document.getElementById('mobile-snippets-btn');
    if (snippetsButton) disposer.observe(snippetsButton, applyVisibility, { attributes: true, attributeFilter: ['class'] });
    disposer.listen(document, 'visibilitychange', () => document.visibilityState === 'visible' && visible && terminalVisible() && void load());
    // 进入终端页时刷新（命令可能在别处改过）；登录状态变化后换用对应的存储
    const terminalSection = document.getElementById('terminal-section');
    let wasVisible = terminalVisible();
    if (terminalSection) {
      disposer.observe(
        terminalSection,
        () => {
          const now = terminalVisible();
          if (now && !wasVisible) void load();
          wasVisible = now;
        },
        { attributes: true, attributeFilter: ['class'] }
      );
    }
    disposer.add(
      subscribe(() => {
        if (loadedAuthenticated !== null && loadedAuthenticated !== authenticated()) void load();
      })
    );
    disposer.add(
      onLocaleChange(() => {
        applyVisibility();
        render();
      })
    );

    applyVisibility();
    render();
    if (terminalVisible()) void load();
    return () => disposer.run();
  },
};
