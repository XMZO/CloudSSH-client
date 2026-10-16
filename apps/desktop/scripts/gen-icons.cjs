/**
 * 由 CloudSSH 网页版 favicon.svg 渲染应用图标（用 Electron 自身渲染，无需额外图像工具）。
 * 用法：pnpm --filter @cloudssh/desktop exec electron scripts/gen-icons.cjs
 * 输出：resources/icon.png（512，electron-builder 会自动转 ico）、resources/tray.png（32）、resources/tray@2x.png（64）
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const svgPath = path.resolve(__dirname, '../../../packages/ui-web/upstream/frontend/public/favicon.svg');
const outDir = path.resolve(__dirname, '../resources');

async function render(svg, size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block">
  </body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  return image;
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(svgPath, 'utf8');
  fs.mkdirSync(outDir, { recursive: true });
  const master = await render(svg, 512);
  for (const [name, size] of [
    ['icon.png', 512],
    ['tray.png', 32],
    ['tray@2x.png', 64],
  ]) {
    const png = size === 512 ? master.toPNG() : master.resize({ width: size, height: size, quality: 'best' }).toPNG();
    fs.writeFileSync(path.join(outDir, name), png);
    console.log(`wrote ${name} (${size}px)`);
  }
  app.quit();
});
