/**
 * 关键词高亮规则编辑器（桌面端与手机端共用）：总开关、效果预览、规则列表（开关/改色/编辑/删除）、
 * 新建、导入导出 JSON、恢复默认。改动立即保存并生效（已打开的终端马上重新着色）。
 */
import { copyTextToClipboard } from '../../../upstream/frontend/src/clipboard';
import { getActiveTerminalTheme } from '../../../upstream/frontend/src/theme';
import { confirmAction, notify } from '../../../upstream/frontend/src/ui-feedback';
import { colorAdjuster } from './highlight-engine';
import {
  builtinRule,
  defaultSettings,
  exportRules,
  loadSettings,
  newRuleId,
  parseImport,
  patternError,
  saveSettings,
  type HighlightRule,
  type HighlightSettings,
} from './highlight-rules';
import { builtinNote, ht } from './i18n';
import './highlight-editor.css';

const SAMPLE = [
  '2026-10-17 15:30:01 INFO  nginx started, listening on 0.0.0.0:443 (pid=1234)',
  'Oct 17 15:30:02 web-01 sshd[2291]: Failed password for invalid user admin from 203.0.113.7 port 52144',
  'Oct 17 15:30:03 web-01 systemd[1]: nginx.service: active (running), 12.5MB memory',
  'WARN  /dev/sda1 is 91% full, retrying in 5s',
  'ERROR connection to 10.0.0.5:5432 refused: timeout after 3000ms',
  '192.0.2.10 - - "GET /api/servers HTTP/1.1" 200 512   "POST /login HTTP/1.1" 403 87',
  'web  Up 3 hours   api  Exited (1)   worker  CrashLoopBackOff   cache  Pending',
  'commit 3f9c2ab1d4  https://github.com/XMZO/CloudSSH  ~/.ssh/config  fe80::1',
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: string): HTMLSpanElement {
  const span = el('span', 'material-symbols-outlined cs-hl-icon', name);
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function iconButton(name: string, label: string, className = 'cs-hl-iconbtn'): HTMLButtonElement {
  const button = el('button', className);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon(name));
  return button;
}

function textButton(name: string, label: string, className = 'cs-hl-btn'): HTMLButtonElement {
  const button = el('button', className);
  button.type = 'button';
  button.append(icon(name), el('span', '', label));
  return button;
}

const noteOf = (rule: HighlightRule) => rule.note ?? builtinNote(rule.id);

/** 预览：对纯文本按规则顺序着色（与终端里的规则一致：先匹配的规则优先） */
function renderPreview(target: HTMLElement, settings: HighlightSettings): void {
  const theme = getActiveTerminalTheme();
  const adjust = colorAdjuster(theme.background);
  target.style.background = theme.background ?? '';
  target.style.color = theme.foreground ?? '';
  const rules = settings.enabled
    ? settings.rules.filter((rule) => rule.enabled).map((rule) => ({ regex: new RegExp(rule.pattern, `g${rule.flags ?? 'i'}`), color: adjust(rule.color) }))
    : [];
  const lines = SAMPLE.map((line) => {
    const colors: (string | null)[] = new Array(line.length).fill(null);
    for (const rule of rules) {
      rule.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.regex.exec(line))) {
        const length = match[0].length;
        if (!length) {
          rule.regex.lastIndex += 1;
          continue;
        }
        const end = match.index + length;
        if (colors.slice(match.index, end).some(Boolean)) continue;
        colors.fill(rule.color, match.index, end);
      }
    }
    const row = el('div', 'cs-hl-preview-line');
    let start = 0;
    for (let i = 1; i <= line.length; i++) {
      if (i === line.length || colors[i] !== colors[start]) {
        const span = el('span', '', line.slice(start, i));
        if (colors[start]) span.style.color = colors[start] as string;
        row.append(span);
        start = i;
      }
    }
    return row;
  });
  target.replaceChildren(...lines);
}

let openRoot: HTMLElement | null = null;

export function closeHighlightEditor(): void {
  openRoot?.remove();
  openRoot = null;
}

export function openHighlightEditor(): void {
  closeHighlightEditor();
  let settings = loadSettings();
  let editingId: string | null = null;
  let panel: 'import' | 'export' | null = null;

  const root = el('div', 'cs-hl-root');
  const dialog = el('div', 'cs-hl-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', ht('title'));
  dialog.tabIndex = -1;
  root.append(dialog);

  const head = el('header', 'cs-hl-head');
  const title = el('h2', 'cs-hl-title', ht('title'));
  const count = el('span', 'cs-hl-count');
  const close = iconButton('close', ht('close'));
  close.addEventListener('click', closeHighlightEditor);
  head.append(title, count, close);

  const body = el('div', 'cs-hl-body');
  dialog.append(head, body);

  const persist = () => {
    saveSettings(settings);
    render();
  };

  // ---------- 总开关 ----------
  const enable = el('label', 'cs-hl-enable');
  const enableInput = el('input');
  enableInput.type = 'checkbox';
  enableInput.className = 'cs-hl-switch';
  enableInput.addEventListener('change', () => {
    settings = { ...settings, enabled: enableInput.checked };
    persist();
  });
  const enableText = el('span', 'cs-hl-enable-text');
  enableText.append(el('strong', '', ht('enable')), el('small', '', ht('enableHint')));
  enable.append(enableText, enableInput);

  // ---------- 预览 ----------
  const previewTitle = el('h3', 'cs-hl-section', ht('preview'));
  const preview = el('div', 'cs-hl-preview');

  // ---------- 工具栏 ----------
  const rulesTitle = el('h3', 'cs-hl-section', ht('rules'));
  const toolbar = el('div', 'cs-hl-toolbar');
  const addButton = textButton('add', ht('add'), 'cs-hl-btn is-primary');
  const importButton = textButton('upload', ht('import'));
  const exportButton = textButton('download', ht('export'));
  const resetButton = textButton('restart_alt', ht('reset'));
  toolbar.append(addButton, importButton, exportButton, resetButton);
  const panelHost = el('div', 'cs-hl-panel-host');
  const list = el('ul', 'cs-hl-list');

  addButton.addEventListener('click', () => {
    const rule: HighlightRule = { id: newRuleId(), enabled: true, pattern: '', note: ht('newRuleNote'), color: '#f59e0b' };
    editingId = rule.id;
    // 新规则先放进列表（未保存的空规则在取消时移除），自定义规则排在最前面、优先生效
    settings = { ...settings, rules: [rule, ...settings.rules] };
    render();
  });
  importButton.addEventListener('click', () => {
    panel = panel === 'import' ? null : 'import';
    render();
  });
  exportButton.addEventListener('click', () => {
    panel = panel === 'export' ? null : 'export';
    render();
  });
  resetButton.addEventListener('click', async () => {
    const ok = await confirmAction({ message: ht('resetConfirm'), confirmText: ht('reset'), cancelText: ht('cancel'), variant: 'warning' });
    if (!ok) return;
    settings = { ...defaultSettings(), enabled: settings.enabled };
    editingId = null;
    persist();
    notify(ht('resetDone'), { variant: 'success', duration: 1500 });
  });

  body.append(enable, previewTitle, preview, rulesTitle, toolbar, panelHost, list);

  // ---------- 导入 / 导出面板 ----------
  function renderPanel(): void {
    if (!panel) {
      panelHost.replaceChildren();
      return;
    }
    const box = el('div', 'cs-hl-panel');
    const area = el('textarea', 'cs-hl-code');
    area.spellcheck = false;
    area.rows = 8;
    const actions = el('div', 'cs-hl-actions');
    if (panel === 'export') {
      box.append(el('p', 'cs-hl-hint', ht('exportHint')));
      area.readOnly = true;
      area.value = JSON.stringify(exportRules(settings.rules, noteOf), null, 2);
      const copy = textButton('content_copy', ht('copy'), 'cs-hl-btn is-primary');
      copy.addEventListener('click', () => {
        void copyTextToClipboard(area.value).then((ok) => ok && notify(ht('copied'), { variant: 'success', duration: 1500 }));
      });
      actions.append(copy);
    } else {
      box.append(el('p', 'cs-hl-hint', ht('importHint')));
      area.placeholder = '[ … ]';
      const apply = (mode: 'replace' | 'append') => {
        let parsed: ReturnType<typeof parseImport>;
        try {
          parsed = parseImport(area.value);
        } catch {
          notify(ht('importInvalid'), { variant: 'danger' });
          return;
        }
        if (!parsed.rules.length) {
          notify(ht('importInvalid'), { variant: 'danger' });
          return;
        }
        // 替换全部：内置规则全部算作“删除过”，以后升级也不会自动加回来
        settings =
          mode === 'replace'
            ? { ...settings, rules: parsed.rules, removed: defaultSettings().rules.map((rule) => rule.id) }
            : { ...settings, rules: [...parsed.rules, ...settings.rules] };
        panel = null;
        persist();
        notify(ht('importDone', { n: parsed.rules.length }) + (parsed.skipped ? ht('importSkipped', { n: parsed.skipped }) : ''), {
          variant: 'success',
        });
      };
      const replace = textButton('swap_horiz', ht('importReplace'));
      replace.addEventListener('click', () => apply('replace'));
      const append = textButton('add', ht('importAppend'), 'cs-hl-btn is-primary');
      append.addEventListener('click', () => apply('append'));
      actions.append(replace, append);
    }
    box.append(area, actions);
    panelHost.replaceChildren(box);
    if (panel === 'import') area.focus();
  }

  // ---------- 规则列表 ----------
  function ruleRow(rule: HighlightRule): HTMLLIElement {
    const item = el('li', 'cs-hl-rule');
    item.dataset.id = rule.id;
    if (!rule.enabled) item.classList.add('is-off');

    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.className = 'cs-hl-check';
    toggle.checked = rule.enabled;
    toggle.setAttribute('aria-label', noteOf(rule));
    toggle.addEventListener('change', () => {
      settings = { ...settings, rules: settings.rules.map((r) => (r.id === rule.id ? { ...r, enabled: toggle.checked } : r)) };
      persist();
    });

    const swatch = el('input');
    swatch.type = 'color';
    swatch.className = 'cs-hl-swatch';
    swatch.value = rule.color;
    swatch.title = ht('color');
    swatch.setAttribute('aria-label', ht('color'));
    swatch.addEventListener('change', () => {
      settings = { ...settings, rules: settings.rules.map((r) => (r.id === rule.id ? { ...r, color: swatch.value.toLowerCase() } : r)) };
      persist();
    });

    const text = el('div', 'cs-hl-rule-text');
    const name = el('div', 'cs-hl-rule-name');
    name.append(el('span', '', noteOf(rule)));
    if (rule.id.startsWith('b-')) name.append(el('span', 'cs-hl-badge', ht('builtin')));
    const sample = el('code', 'cs-hl-rule-pattern', rule.pattern);
    sample.style.color = rule.color;
    text.append(name, sample);

    const edit = iconButton('edit', ht('edit'));
    edit.addEventListener('click', () => {
      editingId = editingId === rule.id ? null : rule.id;
      render();
    });
    const remove = iconButton('delete', ht('delete'));
    remove.addEventListener('click', async () => {
      const ok = await confirmAction({
        message: ht('deleteConfirm', { name: noteOf(rule) }),
        confirmText: ht('delete'),
        cancelText: ht('cancel'),
        variant: 'danger',
      });
      if (!ok) return;
      settings = {
        ...settings,
        rules: settings.rules.filter((r) => r.id !== rule.id),
        removed: rule.id.startsWith('b-') ? [...new Set([...settings.removed, rule.id])] : settings.removed,
      };
      persist();
    });

    const row = el('div', 'cs-hl-rule-row');
    row.append(toggle, swatch, text, edit, remove);
    item.append(row);
    if (editingId === rule.id) item.append(ruleForm(rule));
    return item;
  }

  function ruleForm(rule: HighlightRule): HTMLFormElement {
    const form = el('form', 'cs-hl-form');
    const noteField = el('label', 'cs-hl-field');
    const noteInput = el('input', 'cs-hl-input');
    noteInput.value = noteOf(rule);
    noteInput.maxLength = 80;
    noteField.append(el('span', '', ht('note')), noteInput);

    const patternField = el('label', 'cs-hl-field');
    const patternInput = el('textarea', 'cs-hl-code');
    patternInput.value = rule.pattern;
    patternInput.rows = 3;
    patternInput.spellcheck = false;
    patternInput.autocapitalize = 'off';
    patternField.append(el('span', '', ht('pattern')), patternInput);

    const options = el('div', 'cs-hl-form-options');
    const caseLabel = el('label', 'cs-hl-inline');
    const caseInput = el('input');
    caseInput.type = 'checkbox';
    caseInput.className = 'cs-hl-check';
    caseInput.checked = (rule.flags ?? 'i') === '';
    caseLabel.append(caseInput, el('span', '', ht('caseSensitive')));
    const colorLabel = el('label', 'cs-hl-inline');
    const colorInput = el('input');
    colorInput.type = 'color';
    colorInput.className = 'cs-hl-swatch';
    colorInput.value = rule.color;
    colorLabel.append(colorInput, el('span', '', ht('color')));
    options.append(caseLabel, colorLabel);

    const error = el('p', 'cs-hl-error');
    error.hidden = true;
    const validate = () => {
      const reason = patternError(patternInput.value, caseInput.checked ? '' : 'i');
      error.hidden = !reason;
      error.textContent = reason ? ht('patternInvalid', { reason }) : '';
      return !reason;
    };
    patternInput.addEventListener('input', validate);
    caseInput.addEventListener('change', validate);

    const actions = el('div', 'cs-hl-actions');
    const builtin = builtinRule(rule.id);
    if (builtin) {
      const restore = textButton('restart_alt', ht('restoreBuiltin'));
      restore.addEventListener('click', () => {
        noteInput.value = builtinNote(rule.id);
        patternInput.value = builtin.pattern;
        caseInput.checked = (builtin.flags ?? 'i') === '';
        colorInput.value = builtin.color;
        validate();
      });
      actions.append(restore);
    }
    const cancel = textButton('close', ht('cancel'));
    cancel.addEventListener('click', () => {
      editingId = null;
      // 新建后没保存过的空规则直接丢掉
      settings = { ...settings, rules: settings.rules.filter((r) => r.id !== rule.id || r.pattern) };
      render();
    });
    const save = el('button', 'cs-hl-btn is-primary');
    save.type = 'submit';
    save.append(icon('check'), el('span', '', ht('save')));
    actions.append(cancel, save);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!validate()) return;
      const builtinDefaultNote = builtin ? builtinNote(rule.id) : null;
      const note = noteInput.value.trim();
      const next: HighlightRule = {
        ...rule,
        pattern: patternInput.value,
        note: builtin && (note === '' || note === builtinDefaultNote) ? null : note || ht('newRuleNote'),
        color: colorInput.value.toLowerCase(),
      };
      if (caseInput.checked) next.flags = '';
      else delete next.flags;
      settings = { ...settings, rules: settings.rules.map((r) => (r.id === rule.id ? next : r)) };
      editingId = null;
      persist();
    });

    form.append(noteField, patternField, options, error, actions);
    requestAnimationFrame(() => (rule.pattern ? noteInput : patternInput).focus());
    return form;
  }

  function render(): void {
    enableInput.checked = settings.enabled;
    dialog.classList.toggle('is-disabled', !settings.enabled);
    const on = settings.rules.filter((rule) => rule.enabled).length;
    count.textContent = ht('ruleCount', { on, all: settings.rules.length });
    importButton.classList.toggle('is-on', panel === 'import');
    exportButton.classList.toggle('is-on', panel === 'export');
    renderPreview(preview, settings);
    renderPanel();
    list.replaceChildren(...settings.rules.map(ruleRow));
  }

  root.addEventListener('click', (event) => {
    if (event.target === root) closeHighlightEditor();
  });
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (editingId) {
      editingId = null;
      settings = { ...settings, rules: settings.rules.filter((r) => r.pattern) };
      render();
    } else if (panel) {
      panel = null;
      render();
    } else closeHighlightEditor();
  });

  render();
  document.body.append(root);
  openRoot = root;
  dialog.focus();
}
