/**
 * SFTP 拖放（桌面）：
 *
 * 拖进来上传 —— 从资源管理器把文件或文件夹拖到终端上、或 SFTP 面板任意位置（网页版只认文件列表那一块），
 *   上传到 SFTP 当前目录；面板没开时先打开、等 SFTP 就绪。文件夹按原结构在远端建目录再逐个上传
 *   （目录已存在时照常往里传）。上传本身走网页版的上传队列：进度、续传、校验、重名确认都与点“上传”一致。
 *
 * 拖出去下载 —— 把 SFTP 里的文件（选中多个时一起）拖到桌面或任意文件夹。系统拖放只能拖本地文件，
 *   所以按下拖动后先照常下载到临时目录（面板显示下载进度、光标旁显示“正在准备”），准备好时鼠标还按着就接着
 *   交给系统拖放，已经松开就留着，十分钟内再拖一次直接开始（主进程 drag-out.ts）。目录不能拖出。
 */
import { notify } from '../../upstream/frontend/src/ui-feedback';
import { activeTab, listTabs } from '../sidebar/hooks';
import { el, icon } from './dom';
import { dt } from './i18n';
import { clickById } from './state';
import './sftp-drop.css';

interface SftpEntry {
  name: string;
  size: number;
  modifiedTime: number;
  isDir: boolean;
}

/** 网页版 SFTPPanel 的私有成员（构建后仍是普通属性，按名字访问；缺失时功能降级） */
interface SftpPanelLike {
  container?: HTMLElement;
  visible?: boolean;
  sftpReady?: boolean;
  currentPath?: string;
  renderedEntries?: SftpEntry[];
  selectedEntries?: Map<string, SftpEntry>;
  queueUploadFiles?(files: File[]): void;
  enqueueUploadTask?(file: File, targetPath: string): Promise<boolean>;
  queueDownloadFile?(path: string, filename: string): void;
  sendJSON?(data: unknown): void;
  refresh?(): void;
  onMkdirResult?(path: string): void;
  handleSFTPError?(msg: unknown): void;
  __csMkdirWaiter?: ((ok: boolean) => void) | null;
}

const MAX_UPLOAD_FILES = 2000;
const MKDIR_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_MS = 20_000;

function panelOf(tab: { sftpPanel?: unknown } | null | undefined): SftpPanelLike | null {
  const panel = tab?.sftpPanel as SftpPanelLike | undefined;
  return panel && typeof panel === 'object' ? panel : null;
}

function panelForElement(node: Element): SftpPanelLike | null {
  const container = node.closest('[id="sftp-panel"]');
  if (!container) return null;
  for (const tab of listTabs()) {
    const panel = panelOf(tab);
    if (panel?.container === container) return panel;
  }
  return null;
}

function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`;
}

function hasFiles(event: DragEvent): boolean {
  return !!event.dataTransfer && [...event.dataTransfer.types].includes('Files');
}

// ---------- 拖进来上传 ----------

interface UploadItem {
  file: File;
  /** 相对拖入位置的目录（'' 表示直接放在当前目录） */
  dir: string;
}

function readFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walk(entry: FileSystemEntry, prefix: string, files: UploadItem[], dirs: string[]): Promise<void> {
  if (files.length > MAX_UPLOAD_FILES) return;
  if (entry.isFile) {
    files.push({ file: await readFile(entry as FileSystemFileEntry), dir: prefix });
    return;
  }
  if (!entry.isDirectory) return;
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  dirs.push(path);
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries 每次最多返回一批（Chromium 为 100 个），读到空为止
  for (let batch = await readBatch(reader); batch.length; batch = await readBatch(reader)) {
    for (const child of batch) await walk(child, path, files, dirs);
  }
}

/** drop 事件里同步取出条目（事件结束后 DataTransfer 就读不到了），之后再异步展开文件夹 */
function takeEntries(event: DragEvent): { entries: FileSystemEntry[]; files: File[] } {
  const items = [...(event.dataTransfer?.items ?? [])].filter((item) => item.kind === 'file');
  const entries = items.map((item) => item.webkitGetAsEntry?.() ?? null).filter((entry): entry is FileSystemEntry => !!entry);
  const files = [...(event.dataTransfer?.files ?? [])];
  return { entries: entries.length === items.length ? entries : [], files };
}

/** 让网页版的“新建目录”结果与报错先交给这里（批量建目录时不刷新列表、不弹“已存在”的错误） */
function interceptMkdir(panel: SftpPanelLike): void {
  if ((panel as { __csMkdirPatched?: boolean }).__csMkdirPatched) return;
  (panel as { __csMkdirPatched?: boolean }).__csMkdirPatched = true;
  const onResult = panel.onMkdirResult?.bind(panel);
  const onError = panel.handleSFTPError?.bind(panel);
  panel.onMkdirResult = (path: string) => {
    const waiter = panel.__csMkdirWaiter;
    if (waiter) {
      panel.__csMkdirWaiter = null;
      waiter(true);
      return;
    }
    onResult?.(path);
  };
  panel.handleSFTPError = (msg: unknown) => {
    const waiter = panel.__csMkdirWaiter;
    if (waiter && (msg as { operation?: unknown } | null)?.operation === 'mkdir') {
      panel.__csMkdirWaiter = null;
      waiter(false);
      return;
    }
    onError?.(msg);
  };
}

function mkdir(panel: SftpPanelLike, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      panel.__csMkdirWaiter = null;
      resolve(false);
    }, MKDIR_TIMEOUT_MS);
    panel.__csMkdirWaiter = (ok) => {
      clearTimeout(timer);
      resolve(ok);
    };
    panel.sendJSON?.({ type: 'sftp_mkdir', path });
  });
}

async function waitReady(panel: SftpPanelLike): Promise<boolean> {
  const started = Date.now();
  while (!(panel.visible && panel.sftpReady && panel.currentPath && panel.currentPath !== '~')) {
    if (Date.now() - started > READY_TIMEOUT_MS) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

async function upload(panel: SftpPanelLike, entries: FileSystemEntry[], plainFiles: File[]): Promise<void> {
  if (!panel.visible) clickById('sftp-toggle-btn');
  if (!(await waitReady(panel))) {
    notify(dt('dropNoSftp'), { variant: 'warning' });
    return;
  }
  const base = panel.currentPath!;
  const files: UploadItem[] = [];
  const dirs: string[] = [];
  try {
    if (entries.length) for (const entry of entries) await walk(entry, '', files, dirs);
    else files.push(...plainFiles.map((file) => ({ file, dir: '' })));
  } catch (error) {
    notify(dt('dropReadFailed', { reason: error instanceof Error ? error.message : String(error) }), { variant: 'danger' });
    return;
  }
  if (files.length > MAX_UPLOAD_FILES) {
    notify(dt('dropTooMany', { n: MAX_UPLOAD_FILES }), { variant: 'warning' });
    return;
  }
  if (!files.length && !dirs.length) return;

  if (dirs.length) {
    interceptMkdir(panel);
    // 父目录在前（walk 本身就是先序）；已存在时报错，照常往里传
    for (const dir of dirs) await mkdir(panel, joinPath(base, dir));
    panel.refresh?.();
  }
  const direct = files.filter((item) => !item.dir).map((item) => item.file);
  if (direct.length) panel.queueUploadFiles?.(direct);
  for (const item of files) if (item.dir) void panel.enqueueUploadTask?.(item.file, joinPath(base, item.dir));
  notify(dt('dropQueued', { n: files.length, path: base }), { variant: 'info', duration: 2500 });
}

// ---------- 拖放提示层 ----------

let overlay: HTMLElement | null = null;
let overlayTimer = 0;

function showOverlay(zone: HTMLElement, text: string): void {
  if (!overlay) {
    overlay = el('div', 'cs-drop-overlay');
    overlay.append(icon('upload'), el('span', 'cs-drop-text'));
    document.body.append(overlay);
  }
  const rect = zone.getBoundingClientRect();
  Object.assign(overlay.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  overlay.querySelector('.cs-drop-text')!.textContent = text;
  // dragover 在悬停期间持续触发；停了就说明拖走了或松开了
  clearTimeout(overlayTimer);
  overlayTimer = window.setTimeout(hideOverlay, 200);
}

function hideOverlay(): void {
  clearTimeout(overlayTimer);
  overlay?.remove();
  overlay = null;
}

interface DropZone {
  element: HTMLElement;
  panel: SftpPanelLike | null;
}

function dropZone(target: EventTarget | null): DropZone | null {
  if (!(target instanceof Element)) return null;
  const panelElement = target.closest<HTMLElement>('[id="sftp-panel"]');
  if (panelElement) return { element: panelElement, panel: panelForElement(panelElement) };
  const terminal = document.getElementById('terminal-section');
  if (!terminal || terminal.classList.contains('hidden') || !terminal.contains(target)) return null;
  const area = document.getElementById('terminal-wrapper') ?? document.getElementById('terminal-area') ?? terminal;
  return { element: area, panel: panelOf(activeTab()) };
}

/** 拖出去的文件被放回本窗口（或系统拖放开始时鼠标已经松开）：不当成上传 */
let draggingOut = false;
let draggingOutTimer = 0;

function installDropUpload(): void {
  // 都在捕获阶段处理并停止传播：SFTP 文件列表上网页版自己也有拖放上传（不支持文件夹），统一走这里
  document.addEventListener(
    'dragover',
    (event) => {
      if (!hasFiles(event)) return;
      if (draggingOut) {
        // 拖出去的文件经过本窗口：不接收
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
        return;
      }
      const zone = dropZone(event.target);
      if (!zone) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = zone.panel ? 'copy' : 'none';
      const path = zone.panel?.sftpReady && zone.panel.currentPath && zone.panel.currentPath !== '~' ? zone.panel.currentPath : '';
      showOverlay(zone.element, zone.panel ? (path ? dt('dropUploadTo', { path }) : dt('dropUpload')) : dt('dropNoSftp'));
    },
    true
  );
  document.addEventListener(
    'drop',
    (event) => {
      if (!hasFiles(event)) return;
      hideOverlay();
      if (draggingOut) {
        event.preventDefault();
        event.stopPropagation();
        endDraggingOut();
        return;
      }
      const zone = dropZone(event.target);
      if (!zone) return;
      event.preventDefault();
      event.stopPropagation();
      zone.element.querySelector('#sftp-file-list')?.classList.remove('bg-surface-variant');
      if (!zone.panel) {
        notify(dt('dropNoSftp'), { variant: 'warning' });
        return;
      }
      const { entries, files } = takeEntries(event);
      void upload(zone.panel, entries, files);
    },
    true
  );
}

// ---------- 拖出去下载 ----------

interface Prepared {
  token: string;
  key: string;
  expires: number;
}

const prepared: Prepared[] = [];
const KEEP_MS = 9 * 60 * 1000;

let pending: { token: string; key: string; chip: HTMLElement; pressed: boolean } | null = null;

function newToken(): string {
  return crypto.randomUUID();
}

function endDraggingOut(): void {
  clearTimeout(draggingOutTimer);
  draggingOut = false;
}

function startSystemDrag(token: string): void {
  draggingOut = true;
  clearTimeout(draggingOutTimer);
  // 系统拖放期间页面收不到鼠标事件；结束后第一次移动鼠标（或放回本窗口）时复位
  draggingOutTimer = window.setTimeout(endDraggingOut, 60_000);
  window.cloudsshDesktop?.dragOut?.start(token);
}

function chipAt(chip: HTMLElement, x: number, y: number): void {
  chip.style.transform = `translate(${x + 14}px, ${y + 16}px)`;
}

function entriesToDrag(panel: SftpPanelLike, row: HTMLElement): SftpEntry[] {
  const entry = panel.renderedEntries?.[Number(row.dataset.idx)];
  if (!entry || entry.isDir) return [];
  const selected = panel.selectedEntries;
  if (selected?.has(entry.name) && selected.size > 1) return [...selected.values()].filter((item) => !item.isDir);
  return [entry];
}

/** 事件目标所在的 SFTP 文件行（拖动选中的文字时目标是文字节点） */
function entryRow(target: EventTarget | null): HTMLElement | null {
  const node = target instanceof Node && target.nodeType === Node.TEXT_NODE ? target.parentElement : target;
  return node instanceof Element ? node.closest<HTMLElement>('[id="sftp-panel"] .sftp-entry') : null;
}

function installDragOut(): void {
  const bridge = window.cloudsshDesktop?.dragOut;
  if (!bridge) return;

  // 按下时才让文件行可拖（网页版生成的行没有 draggable），目录不可拖
  document.addEventListener(
    'mousedown',
    (event) => {
      const row = entryRow(event.target);
      if (row) row.draggable = row.dataset.type !== 'dir';
    },
    true
  );

  document.addEventListener(
    'dragstart',
    (event) => {
      const row = entryRow(event.target);
      if (!row) return;
      const panel = panelForElement(row);
      const entries = panel ? entriesToDrag(panel, row) : [];
      // 这里一律取消网页自己的拖动（拖的是网页元素，没有意义），改走系统拖放
      event.preventDefault();
      if (!panel || !entries.length || !panel.queueDownloadFile || pending?.pressed) return;
      // 上一次已经松手、还没准备好（或下载失败了）的拖出：作废，以这次为准
      if (pending) {
        void bridge.release(pending.token);
        finishPending();
      }
      const dir = panel.currentPath ?? '/';
      const key = entries.map((entry) => `${joinPath(dir, entry.name)}|${entry.size}|${entry.modifiedTime}`).sort().join('\n');
      const now = Date.now();
      const cached = prepared.find((item) => item.key === key && item.expires > now);
      if (cached) {
        startSystemDrag(cached.token);
        return;
      }
      const token = newToken();
      const chip = el('div', 'cs-drag-chip');
      chip.append(icon('progress_activity', 'cs-drag-spin'), el('span', '', entries.length > 1 ? dt('dragPreparingMany', { n: entries.length }) : dt('dragPreparing', { name: entries[0].name })));
      document.body.append(chip);
      chipAt(chip, event.clientX, event.clientY);
      pending = { token, key, chip, pressed: true };
      const queue = panel.queueDownloadFile.bind(panel);
      void bridge
        .prepare(token, entries.map((entry) => entry.name))
        .then(() => {
          for (const entry of entries) queue(joinPath(dir, entry.name), entry.name);
        })
        .catch((error: unknown) => {
          finishPending();
          notify(dt('dragFailed', { reason: error instanceof Error ? error.message : String(error) }), { variant: 'danger' });
        });
    },
    true
  );

  const finishPending = () => {
    pending?.chip.remove();
    pending = null;
  };

  window.addEventListener(
    'mousemove',
    (event) => {
      if (draggingOut && (event.buttons & 1) === 0) endDraggingOut();
      if (!pending?.pressed) return;
      if ((event.buttons & 1) === 0) released();
      else chipAt(pending.chip, event.clientX, event.clientY);
    },
    true
  );
  // 松手后收起光标旁的标签（下载进度在 SFTP 面板里照常显示），准备好时提示再拖一次
  const released = () => {
    if (!pending) return;
    pending.pressed = false;
    pending.chip.remove();
  };
  window.addEventListener('mouseup', released, true);
  window.addEventListener('blur', released);

  bridge.onReady((token, ok) => {
    if (!pending || pending.token !== token) {
      void bridge.release(token);
      return;
    }
    const { key, pressed } = pending;
    finishPending();
    if (!ok) {
      void bridge.release(token);
      notify(dt('dragFailed', { reason: '' }), { variant: 'danger' });
      return;
    }
    prepared.push({ token, key, expires: Date.now() + KEEP_MS });
    while (prepared.length > 20) void bridge.release(prepared.shift()!.token);
    if (pressed) startSystemDrag(token);
    else notify(dt('dragReady'), { variant: 'info', duration: 3500 });
  });
}

export function installSftpDragDrop(): void {
  installDropUpload();
  installDragOut();
}
