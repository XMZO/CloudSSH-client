/**
 * 服务器列表（代替客户端的 sidebar/store）：命令行每次从 /api/servers 取一次，放在这里给复用的 ai-remote 代码用。
 * 构建时 build.mjs 把对 sidebar/store 的引用都指到这个文件。
 */
import type { ServerConfig } from '@cloudssh/core';

let servers: ServerConfig[] | null = null;

export function getServers(): ServerConfig[] | null {
  return servers;
}

export function setServers(next: ServerConfig[] | null): void {
  servers = next;
}

export function subscribe(): () => void {
  return () => undefined;
}
