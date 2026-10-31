/**
 * 入口网关（tools/gateway）背后的 SFTP 附加地址。
 *
 * CloudSSH 按自己收到请求的地址生成 SFTP 附加地址（wss://<它的域名>/api/ssh/sftp?session=…&token=…）。会话被网关放到
 * 别的号上的节点时，这个地址是那个节点的域名：直接连过去不同源、也没有那边的登录，SFTP 面板、上传下载都会失败。
 * 网关不改 WebSocket 里的消息，所以由客户端把它换回当前实例（网关）的地址，并带上 via=<原来的主机>，网关据此转给那个节点。
 * 普通实例的附加地址本来就是自己的域名，不受影响。网关转出的网页里插了同样的脚本（gateway.js 的 ATTACH_FIX），浏览器直接打开也一样。
 */

/** 附加地址不是 base 那个主机时，换成 base 的地址并记下原主机；其他地址原样返回 */
export function localizeAttachUrl(url: string, base: string): string {
  try {
    const target = new URL(url, base);
    const home = new URL(base);
    if (target.pathname !== '/api/ssh/sftp' || target.host === home.host) return url;
    const local = new URL(target.pathname + target.search, home);
    local.protocol = home.protocol === 'https:' || home.protocol === 'wss:' ? 'wss:' : 'ws:';
    local.searchParams.set('via', target.host);
    return local.toString();
  } catch {
    return url;
  }
}

type MarkedWebSocket = typeof WebSocket & { __gwAttach?: boolean };

/** 页面和实例同源（电脑端的起源桥、浏览器）时用：新建 WebSocket 时换掉别的节点的附加地址 */
export function installGatewayAttach(): void {
  const Native = window.WebSocket as MarkedWebSocket | undefined;
  if (!Native || Native.__gwAttach) return;
  class GatewayWebSocket extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(localizeAttachUrl(String(url), location.href), protocols);
    }
  }
  (GatewayWebSocket as MarkedWebSocket).__gwAttach = true;
  window.WebSocket = GatewayWebSocket;
}
