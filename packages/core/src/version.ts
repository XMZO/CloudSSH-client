// 由 scripts/version.mjs 根据仓库根目录的 version.json 生成，请勿手改（改版本请运行 node scripts/version.mjs set）。

/** 客户端版本号：与桌面安装包、Android versionName 一致 */
export const CLIENT_VERSION = '0.2.1';

/** 版本代号（中文 / 英文） */
export const CLIENT_CODENAME = { zh: '织女', en: 'Vega' } as const;
