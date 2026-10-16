/** 侧栏文案（跟随网页版当前语言：zh-CN / zh-TW / en-US） */
import { getLocale, onLocaleChange } from '../../upstream/frontend/src/i18n';

const zhCN = {
  title: '节点',
  search: '搜索主机、名称或分组…',
  add: '添加服务器',
  refresh: '刷新',
  sort: '排序',
  collapse: '收起侧栏',
  expand: '展开侧栏',
  sortName: '按名称',
  sortCount: '按节点数',
  sortRecent: '按最近连接',
  ungrouped: '未分组',
  empty: '还没有服务器',
  noMatch: '没有匹配的节点',
  connect: '连接（新标签）',
  focusSession: '切换到已打开的会话',
  edit: '编辑',
  clone: '克隆',
  copyHost: '复制主机地址',
  copied: '已复制',
  sessions: '个会话',
  manageInstances: '实例管理',
  hooksMissing: '当前内置 UI 版本不支持从侧栏连接，请在服务器列表中连接',
} as const;

type Key = keyof typeof zhCN;

const dictionaries: Record<string, Record<Key, string>> = {
  'zh-CN': zhCN,
  'zh-TW': {
    title: '節點',
    search: '搜尋主機、名稱或分組…',
    add: '新增伺服器',
    refresh: '重新整理',
    sort: '排序',
    collapse: '收合側欄',
    expand: '展開側欄',
    sortName: '依名稱',
    sortCount: '依節點數',
    sortRecent: '依最近連線',
    ungrouped: '未分組',
    empty: '還沒有伺服器',
    noMatch: '沒有符合的節點',
    connect: '連線（新分頁）',
    focusSession: '切換到已開啟的工作階段',
    edit: '編輯',
    clone: '複製',
    copyHost: '複製主機位址',
    copied: '已複製',
    sessions: '個工作階段',
    manageInstances: '實例管理',
    hooksMissing: '目前內建 UI 版本不支援從側欄連線，請在伺服器清單中連線',
  },
  'en-US': {
    title: 'Hosts',
    search: 'Search host, name or group…',
    add: 'Add server',
    refresh: 'Refresh',
    sort: 'Sort',
    collapse: 'Collapse sidebar',
    expand: 'Expand sidebar',
    sortName: 'By name',
    sortCount: 'By host count',
    sortRecent: 'Recently connected',
    ungrouped: 'Ungrouped',
    empty: 'No servers yet',
    noMatch: 'No matching hosts',
    connect: 'Connect (new tab)',
    focusSession: 'Switch to open session',
    edit: 'Edit',
    clone: 'Clone',
    copyHost: 'Copy host address',
    copied: 'Copied',
    sessions: 'sessions',
    manageInstances: 'Instances',
    hooksMissing: 'This built-in UI cannot connect from the sidebar; use the server list instead',
  },
};

export function st(key: Key): string {
  return (dictionaries[getLocale()] ?? zhCN)[key] ?? zhCN[key];
}

export { onLocaleChange };
