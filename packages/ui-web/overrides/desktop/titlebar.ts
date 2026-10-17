/**
 * 自绘标题栏（窗口没有系统边框时一定显示；工作台主题下即使有系统边框也显示，作为应用顶栏）。
 *
 *   [菜单] [实例 ▾] │ [服务器] [会话标签… +]   ……可拖动……   [SFTP 命令 AI │ 搜索 导出 断开] [设置]  [系统窗口按钮]
 *
 * - 左侧菜单按钮弹出应用菜单（实例 / 视图 / 帮助），实例名弹出切换实例菜单；都由主进程弹出系统菜单
 * - 会话标签直接把网页版的 #tab-bar 搬进来：重命名、右键菜单、关闭、新建都是网页版原有的行为
 * - 终端工具按钮代点网页版顶栏里收起的按钮，并同步它们的选中、隐藏状态
 * - 系统窗口按钮（Windows / Linux）的颜色跟随标题栏背景，由主进程设置
 * 经典主题下只保留左侧与拖动区，网页版自己的顶栏和标签栏原样显示在下面。
 */
import { onColorSchemeChange } from '../../upstream/frontend/src/theme';
import { el, icon, iconButton, opaqueHex } from './dom';
import { dt, onLocaleChange } from './i18n';
import { toggleSettings } from './settings';
import { clickById, currentView, desktopSkin, SKIN_CHANGED_EVENT, VIEW_CHANGED_EVENT } from './state';
import './titlebar.css';

export interface ChromeEnv {
  /** 窗口没有系统边框（标题栏要负责拖动与系统按钮的位置） */
  customChrome: boolean;
  platform: string;
  instanceName: string;
  instanceUrl: string;
}

/** 抽屉按钮与对应的面板：工作台主题下面板停靠在终端右侧，终端让出宽度（并排看文件、命令、AI） */
const DRAWERS: Record<string, string> = {
  'sftp-toggle-btn': 'sftp-panel',
  'snippet-toggle-btn': 'snippet-panel',
  'agent-toggle-btn': 'agent-panel',
};

/** 停靠后终端至少要留这么宽，窗口太窄（或开着侧栏）时抽屉照网页版那样盖在终端上 */
const MIN_DOCKED_TERMINAL = 420;

let dockWidth = 0;
let dockFrame = 0;
function syncDock(): void {
  let width = 0;
  if (desktopSkin() === 'workbench' && currentView() === 'term') {
    for (const [button, panel] of Object.entries(DRAWERS)) {
      if (!document.getElementById(button)?.classList.contains('active')) continue;
      width = Math.max(width, document.getElementById(panel)?.offsetWidth ?? 0);
    }
    const area = document.getElementById('terminal-section')?.clientWidth ?? window.innerWidth;
    if (area - width < MIN_DOCKED_TERMINAL) width = 0;
  }
  if (width === dockWidth) return;
  dockWidth = width;
  const html = document.documentElement;
  html.style.setProperty('--cs-dock-w', `${width}px`);
  html.classList.toggle('cs-docked', width > 0);
  // 终端按新宽度重新计算列数
  cancelAnimationFrame(dockFrame);
  dockFrame = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

/** 终端工具：代点网页版顶栏里的按钮 */
const TOOLS = [
  { id: 'sftp-toggle-btn', icon: 'folder_open', label: () => dt('sftp'), toggle: true },
  { id: 'snippet-toggle-btn', icon: 'bolt', label: () => dt('snippets'), toggle: true },
  { id: 'agent-toggle-btn', icon: 'smart_toy', label: () => dt('agent'), toggle: true },
  { id: 'search-btn', icon: 'search', label: () => dt('search'), toggle: false },
  { id: 'export-btn', icon: 'download', label: () => dt('export'), toggle: false },
  { id: 'disconnect-btn', icon: 'power_settings_new', label: () => dt('disconnect'), toggle: false },
] as const;

export function mountTitlebar(env: ChromeEnv): void {
  const html = document.documentElement;
  if (env.customChrome) html.classList.add('cs-frameless');

  const bar = el('header', 'cs-tb');
  bar.id = 'cs-titlebar';

  // ---------- 左侧：菜单、实例 ----------
  const lead = el('div', 'cs-tb-lead');
  const bridge = window.cloudsshDesktop;
  const menu = el('button', 'cs-tb-menu');
  menu.type = 'button';
  menu.append(el('span', 'cs-tb-logo', '>_'));
  menu.addEventListener('click', () => {
    const rect = menu.getBoundingClientRect();
    void bridge?.showAppMenu?.(rect.left, rect.bottom);
  });
  const instance = el('button', 'cs-tb-instance');
  instance.type = 'button';
  instance.append(el('span', 'cs-tb-instance-name', env.instanceName || 'CloudSSH'), icon('expand_more'));
  // 窄窗口只显示箭头，名称放在提示里
  instance.title = `${env.instanceName || 'CloudSSH'}\n${env.instanceUrl}`;
  instance.addEventListener('click', () => {
    const rect = instance.getBoundingClientRect();
    void bridge?.showInstanceMenu?.(rect.left, rect.bottom);
  });
  if (!bridge?.showAppMenu) menu.disabled = true;
  if (!bridge?.showInstanceMenu) instance.disabled = true;
  lead.append(menu, instance);

  // ---------- 中间：服务器页、会话标签 ----------
  const nav = el('nav', 'cs-tb-nav');
  const home = el('button', 'cs-tb-home');
  home.type = 'button';
  home.append(icon('dns'), el('span', 'cs-tb-home-label'));
  home.addEventListener('click', () => {
    // 网页版的“+”就是回到连接页（服务器列表）
    if (currentView() === 'term') clickById('new-tab-btn');
  });
  const tabsSlot = el('div', 'cs-tb-tabs');
  nav.append(home, tabsSlot);

  // 在服务器列表页点会话标签：网页版只切换了活动标签，还要切回终端视图
  tabsSlot.addEventListener('click', (event) => {
    const target = event.target as Element;
    if (!target.closest('.tab-item') || target.closest('.tab-close')) return;
    if (currentView() !== 'term') setTimeout(() => clickById('back-to-terminal-btn'), 0);
  });
  // 标签放不下时横向滚动：鼠标滚轮直接左右滚，当前标签始终滚到可见处
  tabsSlot.addEventListener(
    'wheel',
    (event) => {
      const tabBar = document.getElementById('tab-bar');
      if (!tabBar || tabBar.scrollWidth <= tabBar.clientWidth || event.deltaX !== 0) return;
      tabBar.scrollLeft += event.deltaY;
      event.preventDefault();
    },
    { passive: false }
  );
  // 放不下时（cs-overflow）右端“+”加一道阴影盖住滚到下面的标签；左边有标签被滚出去时（cs-scrolled）左端淡出
  const syncTabEdges = () => {
    const tabBar = document.getElementById('tab-bar');
    if (!tabBar) return;
    tabBar.classList.toggle('cs-overflow', tabBar.scrollWidth > tabBar.clientWidth + 1);
    tabBar.classList.toggle('cs-scrolled', tabBar.scrollLeft > 0);
  };
  let revealFrame = 0;
  const revealActiveTab = () => {
    cancelAnimationFrame(revealFrame);
    revealFrame = requestAnimationFrame(() => {
      document.querySelector('.cs-tb #tab-bar .tab-item.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      syncTabEdges();
    });
  };
  new ResizeObserver(syncTabEdges).observe(tabsSlot);
  const tabBarNode = document.getElementById('tab-bar');
  if (tabBarNode) {
    // 只看标签增减与切换；状态点、标签栏自己的 class（cs-scrolled 等）变化不算，否则滚轮一滚又被拉回当前标签
    new MutationObserver((records) => {
      const changed = records.some(
        (record) => (record.type === 'childList' && record.target === tabBarNode) || (record.target as Element).classList?.contains('tab-item')
      );
      if (changed) revealActiveTab();
    }).observe(tabBarNode, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    tabBarNode.addEventListener('scroll', syncTabEdges, { passive: true });
  }

  const drag = el('div', 'cs-tb-drag');

  // ---------- 右侧：终端工具、设置 ----------
  const tools = el('div', 'cs-tb-tools');
  const toolButtons = TOOLS.map((tool) => {
    const button = iconButton(tool.icon, tool.label(), `cs-tb-btn cs-tb-tool${tool.toggle ? ' is-toggle' : ''}`);
    button.dataset.tool = tool.id;
    if (tool.id === 'disconnect-btn') button.classList.add('is-danger');
    button.addEventListener('click', () => clickById(tool.id));
    return button;
  });
  tools.append(...toolButtons.slice(0, 3), el('span', 'cs-tb-sep'), ...toolButtons.slice(3));
  const settings = iconButton('settings', dt('settings'), 'cs-tb-btn cs-tb-settings');
  settings.setAttribute('aria-haspopup', 'dialog');
  settings.addEventListener('click', () => toggleSettings(settings));

  bar.append(lead, nav, drag, tools, settings);
  document.body.prepend(bar);

  // ---------- 同步 ----------
  const applyTexts = () => {
    home.querySelector('.cs-tb-home-label')!.textContent = dt('home');
    home.title = dt('home');
    menu.title = menu.ariaLabel = dt('menu');
    instance.setAttribute('aria-label', `${dt('instanceMenu')}：${env.instanceName}`);
    settings.title = dt('settings');
    settings.setAttribute('aria-label', dt('settings'));
    TOOLS.forEach((tool, index) => {
      toolButtons[index].title = tool.label();
      toolButtons[index].setAttribute('aria-label', tool.label());
    });
  };

  /** 工具按钮跟随网页版按钮的选中（active）与隐藏（hidden）状态 */
  const syncTools = () => {
    for (const button of toolButtons) {
      const source = document.getElementById(button.dataset.tool!);
      button.hidden = !source || source.classList.contains('hidden');
      const on = !!source?.classList.contains('active');
      button.classList.toggle('is-on', on);
      if (button.classList.contains('is-toggle')) button.setAttribute('aria-pressed', String(on));
    }
  };
  const drawerBar = document.getElementById('terminal-drawer-segmented-bar');
  if (drawerBar) {
    new MutationObserver(() => {
      syncTools();
      syncDock();
    }).observe(drawerBar, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }
  // 面板可以拖动改宽度；窗口缩放、侧栏开合后重新判断放不放得下
  const panelResize = new ResizeObserver(() => syncDock());
  for (const panel of Object.values(DRAWERS)) {
    const node = document.getElementById(panel);
    if (node) panelResize.observe(node);
  }
  const section = document.getElementById('terminal-section');
  if (section) panelResize.observe(section);
  window.addEventListener('resize', syncDock);

  // 会话标签：工作台主题下把网页版的标签栏搬进标题栏，切回经典时放回原处
  let tabHome: { parent: Node; next: Node | null } | null = null;
  const adoptTabs = () => {
    const tabBar = document.getElementById('tab-bar');
    if (!tabBar || tabsSlot.contains(tabBar)) return;
    tabHome = { parent: tabBar.parentNode!, next: tabBar.nextSibling };
    tabsSlot.append(tabBar);
  };
  const releaseTabs = () => {
    const tabBar = document.getElementById('tab-bar');
    if (!tabBar || !tabHome || !tabsSlot.contains(tabBar)) return;
    const { parent, next } = tabHome;
    parent.insertBefore(tabBar, next && next.parentNode === parent ? next : null);
    tabHome = null;
  };
  const applySkin = () => {
    const workbench = desktopSkin() === 'workbench';
    if (workbench) adoptTabs();
    else releaseTabs();
    syncTools();
    syncDock();
    syncCaption();
  };

  // 系统窗口按钮（Windows / Linux）跟随标题栏的背景与文字颜色
  let lastCaption = '';
  const syncCaption = () => {
    if (!env.customChrome || !bridge?.setTitleBarColors) return;
    const style = getComputedStyle(bar);
    const page = opaqueHex(getComputedStyle(document.body).backgroundColor) ?? '#131313';
    const color = opaqueHex(style.backgroundColor, page);
    const symbol = opaqueHex(style.color, color ?? page);
    if (!color || !symbol || `${color}${symbol}` === lastCaption) return;
    lastCaption = `${color}${symbol}`;
    void bridge.setTitleBarColors(color, symbol);
  };
  let captionFrame = 0;
  const scheduleCaption = () => {
    cancelAnimationFrame(captionFrame);
    // 主题过渡动画结束后再取色
    captionFrame = requestAnimationFrame(() => setTimeout(syncCaption, 260));
  };
  onColorSchemeChange(scheduleCaption);
  new MutationObserver(scheduleCaption).observe(html, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-ui-style', 'data-cs-desk'] });

  window.addEventListener(SKIN_CHANGED_EVENT, applySkin);
  window.addEventListener(VIEW_CHANGED_EVENT, () => {
    home.classList.toggle('is-on', currentView() === 'home');
    syncTools();
    syncDock();
  });
  onLocaleChange(applyTexts);
  applyTexts();
  applySkin();
  home.classList.toggle('is-on', currentView() === 'home');
}
