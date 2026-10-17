/** 客户端版本的显示文本（版本号与代号来自 version.json，由 scripts/version.mjs 同步） */
import { CLIENT_CODENAME, CLIENT_VERSION } from '@cloudssh/core';
import { app } from 'electron';

/** 如 v0.2.0「织女 Vega」；运行的不是同步过的版本时（理论上不会发生）只显示版本号，不张冠李戴 */
export function versionLabel(): string {
  const version = app.getVersion();
  return version === CLIENT_VERSION ? `v${version}「${CLIENT_CODENAME.zh} ${CLIENT_CODENAME.en}」` : `v${version}`;
}
