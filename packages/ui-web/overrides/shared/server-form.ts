/**
 * “添加 / 编辑服务器”对话框的紧凑排版（电脑与手机共用）。网页版每个字段标题单独占一行、字段之间留大间距，
 * 加上标签点选、凭据预设后要滚动好几屏。这里不加宽对话框、不折叠、不分页，只把同样的内容排得更紧：
 *   - 标题放到输入框左边（一列对齐），端口与主机同一行
 *   - 固定不变的说明文字（标签的逗号分隔、跳板的层数限制）收进输入框的提示（悬停 / 长按可见，读屏照读）
 *   - 已有标签排成一行，放不下时横向滚动（电脑上滚轮即可横向滚）
 * 排版全部在 server-form.css 里用选择器完成，不移动网页版的任何元素；网页版按 id 读写字段、按内联样式显示隐藏，都不受影响。
 */
import './server-form.css';

/** 把固定的说明文字挂到字段上：悬停提示 + aria-describedby（说明本身在紧凑排版里隐藏） */
function describe(fieldId: string, hintId: string): void {
  const field = document.getElementById(fieldId);
  // 说明是字段后面的 div（标题 label 也带 text-muted，不能误选）
  const hint = field?.parentElement?.querySelector<HTMLElement>(':scope > div.text-muted');
  if (!field || !hint) return;
  hint.id = hint.id || hintId;
  hint.classList.add('cs-sf-hint');
  field.setAttribute('aria-describedby', hint.id);
  const sync = () => {
    field.title = hint.textContent?.trim() ?? '';
  };
  sync();
  // 切换语言时网页版会重写说明文字
  new MutationObserver(sync).observe(hint, { childList: true, characterData: true, subtree: true });
}

export function installCompactServerForm(): void {
  const form = document.getElementById('server-form');
  if (!form) return;
  document.documentElement.classList.add('cs-sf-on');
  describe('server-tags', 'cs-sf-tags-hint');
  describe('server-jump-host', 'cs-sf-jump-hint');
  // 隧道模式下“区域”的长说明：收进区域下拉框的提示，只在说明显示（隧道模式）时挂上
  const region = document.getElementById('server-region');
  const regionHint = document.getElementById('server-region-tunnel-hint');
  if (region && regionHint) {
    regionHint.classList.add('cs-sf-hint');
    const base = (region.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id && id !== regionHint.id);
    const sync = () => {
      const on = !regionHint.classList.contains('hidden');
      region.title = on ? (regionHint.textContent?.trim() ?? '') : '';
      region.setAttribute('aria-describedby', (on ? [...base, regionHint.id] : base).join(' '));
    };
    sync();
    new MutationObserver(sync).observe(regionHint, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });
  }
  // 端口的标题在紧凑排版里隐藏（紧跟在主机后面，前面有冒号），给输入框补上无障碍名称
  const port = document.getElementById('server-port');
  const portLabel = document.querySelector<HTMLElement>('label[for="server-port"]');
  if (port && portLabel && !port.getAttribute('aria-label')) {
    const sync = () => port.setAttribute('aria-label', portLabel.textContent?.trim() || 'Port');
    sync();
    new MutationObserver(sync).observe(portLabel, { childList: true, characterData: true, subtree: true });
  }
  // 已有标签只排一行：电脑上滚轮直接横向滚动
  form.addEventListener(
    'wheel',
    (event) => {
      const chips = (event.target as Element | null)?.closest?.<HTMLElement>('.cs-tag-picker-chips');
      if (!chips || chips.scrollWidth <= chips.clientWidth || event.deltaX !== 0) return;
      chips.scrollLeft += event.deltaY;
      event.preventDefault();
    },
    { passive: false }
  );
}
