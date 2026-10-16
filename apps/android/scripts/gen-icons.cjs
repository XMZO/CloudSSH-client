/**
 * 生成 Android 启动图标（用桌面端的 Electron 渲染 SVG，无需额外图像工具）：
 *   pnpm --filter @cloudssh/desktop exec electron ../android/scripts/gen-icons.cjs
 * 输出：mipmap-*dpi/ic_launcher(.png|_round.png|_foreground.png) 与 mipmap-anydpi-v26 自适应图标
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const res = path.resolve(__dirname, '../app/src/main/res');
const faviconSvg = fs.readFileSync(
  path.resolve(__dirname, '../../../packages/ui-web/upstream/frontend/public/favicon.svg'),
  'utf8'
);
// 自适应图标前景：108x108 画布，字形放在中心 66dp 安全区内
const foregroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">
  <g transform="translate(54 54) scale(2.4) translate(-16 -16)">
    <path d="M8 11L14 16L8 21" stroke="#4af626" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <line x1="16" y1="21" x2="24" y2="21" stroke="#4af626" stroke-width="2.5" stroke-linecap="round"/>
  </g>
</svg>`;

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

let win = null;
/** 复用同一个离屏窗口：连续新建窗口加载 data: URL 会偶发 ERR_FAILED */
async function render(svg, size) {
  if (!win) {
    win = new BrowserWindow({
      width: size,
      height: size,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      useContentSize: true,
      webPreferences: { offscreen: true },
    });
  }
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block">
  </body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 300));
  return win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
}

app.whenReady().then(async () => {
  const legacy = await render(faviconSvg, 512);
  const foreground = await render(foregroundSvg, 512);
  for (const [density, scale] of Object.entries(DENSITIES)) {
    const dir = path.join(res, `mipmap-${density}`);
    fs.mkdirSync(dir, { recursive: true });
    const icon = Math.round(48 * scale);
    const fg = Math.round(108 * scale);
    const legacyPng = legacy.resize({ width: icon, height: icon, quality: 'best' }).toPNG();
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), legacyPng);
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), legacyPng);
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), foreground.resize({ width: fg, height: fg, quality: 'best' }).toPNG());
    console.log(`mipmap-${density}: ${icon}px / foreground ${fg}px`);
  }
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
  const anydpi = path.join(res, 'mipmap-anydpi-v26');
  fs.mkdirSync(anydpi, { recursive: true });
  fs.writeFileSync(path.join(anydpi, 'ic_launcher.xml'), adaptive);
  fs.writeFileSync(path.join(anydpi, 'ic_launcher_round.xml'), adaptive);
  win?.destroy();
  app.quit();
});
