/**
 * 桌面端在网页版任何脚本之前执行的部分（vite 以 head-prepend 注入）：启动首屏（../shared/boot-core.ts）。
 *
 * 缓存的服务器列表由主进程存在应用数据目录（apps/desktop/src/main/platform/ui-cache.ts，按实例分开）；
 * 有缓存就说明上次登录着（登出、登录失效时会删掉）。不在客户端里、旧版客户端没有这个接口时页面照常显示。
 * 样式在 ./boot.css（藏着连接页与列表页直到启动完成）。
 */
import { installAuthRetry, installBootCore, skipBoot } from '../shared/boot-core';
import { installConnectionDiagnostics } from '../shared/terminal/connection-diagnostics';
import './boot.css';

installConnectionDiagnostics();

const cache = window.cloudsshDesktop?.uiCache;
if (cache) {
  const core = installBootCore({
    cached: cache.read('servers'),
    write: (value) => cache.write('servers', value),
  });
  installAuthRetry(core);
} else {
  skipBoot();
}
