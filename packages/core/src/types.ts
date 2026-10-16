/**
 * CloudSSH Worker 对外接口的协议类型（客户端视角的子集）。
 * 来源：CloudSSH 仓库 src/types.ts、src/worker/index.ts。服务端升级后请同步核对。
 */

export type AuthMode = 'password' | 'github' | 'anonymous';

export interface PasswordAuthParams {
  kdf: 'pbkdf2-sha256';
  iterations: number;
  /** base64url，非机密 */
  salt: string;
}

/** GET /api/config */
export interface PublicConfig {
  turnstileEnabled: boolean;
  sitekey: string;
  githubAuthEnabled: boolean;
  /** 语义为“要求登录”（GitHub 或单管理员密码会话均满足） */
  githubAuthRequired: boolean;
  sshSharingEnabled: boolean;
  authMode: AuthMode;
  passwordAuth: PasswordAuthParams | null;
  passwordHashInvalid: boolean;
}

/** GET /api/health */
export interface HealthResponse {
  status: 'ok';
  timestamp: number;
}

/** GET /api/auth/me */
export interface UserInfo {
  id: number;
  github_id: number;
  username: string;
  /** 本地管理员（密码模式）恒为 null */
  avatar_url: string | null;
}

export const ALLOWED_LOCATION_HINTS = [
  'wnam',
  'enam',
  'sam',
  'weur',
  'eeur',
  'apac',
  'apac-ne',
  'apac-se',
  'oc',
  'afr',
  'me',
] as const;
export type LocationHint = (typeof ALLOWED_LOCATION_HINTS)[number];

/** GET /api/servers 列表项 */
export interface ServerConfig {
  id: number;
  user_id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: 'password' | 'publickey';
  region?: string | null;
  inferred_hint?: string | null;
  tags: string[];
  os?: string | null;
  jump_server_id?: number | null;
  transport_type?: 'direct' | 'cf_tunnel';
  cf_tunnel_host?: string | null;
  cf_access_client_id?: string | null;
  has_cf_access_client_secret?: boolean;
  last_connected_at?: number | null;
  created_at: string;
  updated_at: string;
}

/** POST /api/servers/:id/connect */
export interface ConnectResponse {
  /** 一次性 WebSocket 地址：wss://<worker>/api/ssh?token=... */
  wsUrl: string;
}

/** POST /api/share/claim */
export interface ShareClaimResponse {
  wsUrl: string;
  serverName: string;
  sessionExpiresAt: number;
}

/** WebSocket：会话建立 */
export interface SessionCreatedMessage {
  type: 'session_created';
  sessionId: string;
  resumeToken: string;
  expiresIn: number;
  deviceBound?: boolean;
  resumeEnabled?: boolean;
}

/** WebSocket：断线恢复成功 */
export interface SessionResumedMessage {
  type: 'session_resumed';
  sessionId: string;
  resumeToken?: string;
  sftpAttachUrl?: string;
}

export interface ApiErrorBody {
  error?: string;
  code?: string;
  [key: string]: unknown;
}
