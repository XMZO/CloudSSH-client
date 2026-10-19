/**
 * 重新编译 Windows 启动器（cloudssh-shim.exe），更新仓库里提交的那一份。
 *
 * 启动器很少改，编好的 exe 直接提交在 packages/cli/shim/cloudssh-shim.exe：平时构建命令行（packages/cli/build.mjs）
 * 只是把它复制进 dist/，不需要 Rust。改了 src/main.rs 才要跑这里：需要 Rust（x86_64-pc-windows-msvc）与
 * Visual Studio 生成工具（链接器）。
 *
 *   pnpm cli:shim        （= node packages/cli/shim/build.mjs）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const target = 'x86_64-pc-windows-msvc';
const result = spawnSync('cargo', ['build', '--release', '--locked', '--target', target], { cwd: root, stdio: 'inherit', shell: false });
if (result.error) {
  console.error(`没能运行 cargo：${result.error.message}（需要安装 Rust）`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
const built = path.join(root, 'target', target, 'release', 'cloudssh-shim.exe');
const out = path.join(root, 'cloudssh-shim.exe');
fs.copyFileSync(built, out);
console.log(`已更新 ${path.relative(process.cwd(), out)}（${fs.statSync(out).size} 字节）`);
