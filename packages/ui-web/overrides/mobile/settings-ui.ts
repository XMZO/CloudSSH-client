/**
 * 设置页的列表控件：分组卡片里一项设置一行（左边标题与一行说明，右边控件），
 * 开关、分段选择、数值、按钮统一样式。两种主题共用，颜色全部取主题变量。
 */
import { el, icon } from './sheet';
import './settings.css';

export interface RowOptions {
  title: string;
  /** 标题下的一行说明 */
  sub?: string;
  /** 行首图标（Material Symbols 名称） */
  lead?: string;
  /** 行尾控件 */
  end?: HTMLElement | null;
  /** 整行可点：交给按钮，行尾显示箭头 */
  onClick?: () => void;
  /** 控件放不下时换到标题下面一行 */
  wrap?: boolean;
}

function rowText(title: string, sub?: string): HTMLElement {
  const text = el('span', 'cs-set-text');
  text.append(el('span', 'cs-set-title', title));
  if (sub !== undefined) text.append(el('span', 'cs-set-sub', sub));
  return text;
}

function chevron(): HTMLElement {
  const node = icon('chevron_right');
  node.classList.add('cs-set-chevron');
  return node;
}

export function settingsRow(options: RowOptions): HTMLElement {
  const row = options.onClick ? el('button', 'cs-set-row') : el('div', 'cs-set-row');
  if (row instanceof HTMLButtonElement && options.onClick) {
    row.type = 'button';
    row.addEventListener('click', options.onClick);
  }
  if (options.wrap) row.classList.add('is-wrap');
  if (options.lead) {
    const lead = icon(options.lead);
    lead.classList.add('cs-set-lead');
    row.append(lead);
  }
  row.append(rowText(options.title, options.sub));
  if (options.end) {
    options.end.classList.add('cs-set-end');
    row.append(options.end);
  }
  if (options.onClick) row.append(chevron());
  return row;
}

/** 分组：标题 + 卡片；data-group 供顶部的分组导航定位 */
export function settingsGroup(id: string, title: string, rows: HTMLElement[]): HTMLElement {
  const group = el('section', 'cs-set-group');
  group.dataset.group = id;
  group.setAttribute('aria-label', title);
  const card = el('div', 'cs-set-card');
  card.append(...rows);
  group.append(el('h3', 'cs-set-group-title', title), card);
  return group;
}

export function toggle(checked: boolean, label: string, onChange: (on: boolean) => void): HTMLInputElement {
  const input = el('input', 'cs-ob-switch');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-label', label);
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

/** 整行都能切换的开关项 */
export function toggleRow(options: { title: string; sub?: string; checked: boolean; onChange: (on: boolean) => void }): HTMLElement {
  const row = el('label', 'cs-set-row');
  const input = toggle(options.checked, options.title, options.onChange);
  input.classList.add('cs-set-end');
  row.append(rowText(options.title, options.sub), input);
  return row;
}

/**
 * 左边点开详情、右边开关（Android 设置里带分隔线的开关项）：
 * 例如“关键词高亮”，点文字管理规则，拨开关整体启用/停用。
 */
export function splitToggleRow(options: { title: string; sub: string; checked: boolean; onOpen: () => void; onChange: (on: boolean) => void }): HTMLElement {
  const row = el('div', 'cs-set-row is-split');
  const open = el('button', 'cs-set-split-main');
  open.type = 'button';
  open.append(rowText(options.title, options.sub), chevron());
  open.addEventListener('click', options.onOpen);
  const input = toggle(options.checked, options.title, options.onChange);
  input.classList.add('cs-set-end');
  row.append(open, el('span', 'cs-set-divider'), input);
  return row;
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** 选项前的小图形（例如主题缩略） */
  art?: HTMLElement;
}

export function segmented<T extends string>(label: string, options: SegmentOption<T>[], current: T, onPick: (value: T) => void): HTMLElement {
  const group = el('div', 'cs-set-seg');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);
  const sync = (value: T) => {
    group.querySelectorAll<HTMLButtonElement>('.cs-set-seg-item').forEach((item) => {
      const on = item.dataset.value === value;
      item.classList.toggle('is-on', on);
      item.setAttribute('aria-checked', String(on));
    });
  };
  for (const option of options) {
    const item = el('button', 'cs-set-seg-item');
    item.type = 'button';
    item.dataset.value = option.value;
    item.setAttribute('role', 'radio');
    if (option.art) item.append(option.art);
    item.append(el('span', '', option.label));
    item.addEventListener('click', () => {
      sync(option.value);
      onPick(option.value);
    });
    group.append(item);
  }
  sync(current);
  return group;
}

export function smallButton(label: string, onClick: () => void, variant: '' | 'danger' = ''): HTMLButtonElement {
  const button = el('button', `cs-set-btn${variant ? ` is-${variant}` : ''}`, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

/**
 * 顶部的分组导航：点一下跳到对应分组，滚动时高亮当前所在的分组。
 * 内容仍是一整页，导航只负责定位。
 */
export function groupNav(groups: HTMLElement[], label: string): HTMLElement {
  const nav = el('nav', 'cs-set-nav');
  nav.setAttribute('aria-label', label);
  const chips = new Map<string, HTMLButtonElement>();
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  let active = '';
  const setActive = (id: string) => {
    if (id === active) return;
    active = id;
    for (const [key, chip] of chips) {
      const on = key === id;
      chip.classList.toggle('is-on', on);
      if (on) chip.setAttribute('aria-current', 'true');
      else chip.removeAttribute('aria-current');
    }
    // 导航放不下时（例如英文）横向滚动，让当前分组的标签露出来
    const chip = chips.get(id);
    if (!chip) return;
    const left = chip.offsetLeft - 16;
    const right = chip.offsetLeft + chip.offsetWidth + 16 - nav.clientWidth;
    if (nav.scrollLeft > left) nav.scrollTo({ left, behavior: reduceMotion() ? 'auto' : 'smooth' });
    else if (nav.scrollLeft < right) nav.scrollTo({ left: right, behavior: reduceMotion() ? 'auto' : 'smooth' });
  };

  for (const group of groups) {
    const id = group.dataset.group ?? '';
    const chip = el('button', 'cs-set-nav-chip', group.getAttribute('aria-label') ?? id);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      const scroller = nav.closest<HTMLElement>('.cs-m-sheet');
      if (!scroller) return;
      const top = group.offsetTop - nav.offsetHeight - 6;
      scroller.scrollTo({ top: Math.max(0, top), behavior: reduceMotion() ? 'auto' : 'smooth' });
      setActive(id);
    });
    chips.set(id, chip);
    nav.append(chip);
  }

  // 面板挂到页面上之后再找滚动容器
  requestAnimationFrame(() => {
    const scroller = nav.closest<HTMLElement>('.cs-m-sheet');
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = scroller.scrollTop + nav.offsetHeight + 24;
      let current = groups[0]?.dataset.group ?? '';
      for (const group of groups) if (group.offsetTop <= line) current = group.dataset.group ?? current;
      // 滚到底时最后一组可能够不到判定线
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) current = groups[groups.length - 1]?.dataset.group ?? current;
      setActive(current);
    };
    scroller.addEventListener(
      'scroll',
      () => {
        if (!frame) frame = requestAnimationFrame(update);
      },
      { passive: true }
    );
    update();
  });
  return nav;
}
