import { ReiClient } from '@rei-standard/amsg-client';
import { InstantPushConfig, APIConfig } from '../types';

export const INSTANT_PUSH_CONFIG_KEY = 'instant_push_config_v1';

// ── Types ──────────────────────────────────────────────────────────────────

export interface PushSubscriptionInfo {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface InstantPushPayload {
  contactName: string;
  completePrompt: string;
  apiUrl: string;
  apiKey: string;
  primaryModel: string;
  pushSubscription: PushSubscriptionInfo;
  avatarUrl?: string;
  maxTokens?: number;
  messageSubtype?: string;
  metadata?: Record<string, unknown>;
}

// ── localStorage helpers ───────────────────────────────────────────────────

const DEFAULT_CONFIG: InstantPushConfig = {
  enabled: false,
  workerUrl: '',
  vapidPublicKey: '',
};

export function loadInstantConfig(): InstantPushConfig {
  try {
    const raw = localStorage.getItem(INSTANT_PUSH_CONFIG_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

export function saveInstantConfig(cfg: InstantPushConfig): void {
  try {
    localStorage.setItem(INSTANT_PUSH_CONFIG_KEY, JSON.stringify({ ...cfg, updatedAt: Date.now() }));
  } catch { /* ignore */ }
  // Invalidate cached ReiClient so next call rebuilds with new config.
  _cachedClient = null;
  _cachedClientKey = '';
}

export function clearInstantConfig(): void {
  try { localStorage.removeItem(INSTANT_PUSH_CONFIG_KEY); } catch { /* ignore */ }
  _cachedClient = null;
  _cachedClientKey = '';
}

export function isInstantConfigReady(cfg?: InstantPushConfig): boolean {
  const c = cfg ?? loadInstantConfig();
  return (
    c.enabled &&
    c.workerUrl.startsWith('https://') &&
    c.vapidPublicKey.length > 60
  );
}

// ── Web Push subscription helpers ─────────────────────────────────────────

function b64uToBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const padded = b64u.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (b64u.length % 4)) % 4);
  const bin = atob(padded);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64u(buf: ArrayBuffer | null | undefined): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isDeadEndpoint(endpoint: string | null | undefined): boolean {
  if (!endpoint) return false;
  return endpoint.includes('permanently-removed.invalid');
}

function explainSubscribeError(e: unknown): string {
  const err = e as { name?: string; message?: string } | null;
  const name = err?.name || '';
  const msg = err?.message || String(e || '未知错误');
  if (name === 'NotAllowedError') {
    return '浏览器拒绝创建订阅（NotAllowedError）——通常是站点权限被拦截或处于隐身模式';
  }
  if (name === 'NotSupportedError') {
    return '当前浏览器不支持网页推送——国行安卓或自带浏览器常见，换 Chrome / Edge / Firefox 桌面版试试';
  }
  if (name === 'AbortError' || /push service|FCM|network/i.test(msg)) {
    return '连不上推送服务器——常见于无谷歌服务的国行安卓，或网络挡住了推送服务器，建议换装了谷歌服务的设备或桌面 Chrome 试试';
  }
  if (name === 'InvalidStateError') {
    return '订阅状态冲突（InvalidStateError）——可能旧订阅没清干净，刷新页面后重试';
  }
  return `订阅创建失败（${name || 'Error'}：${msg}）`;
}

export async function getOrCreateInstantSubscription(
  vapidPublicKey: string,
): Promise<{ sub: PushSubscriptionInfo | null; reason?: string }> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { sub: null, reason: '当前浏览器不支持 Service Worker 或 Push API' };
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();

  if (sub && isDeadEndpoint(sub.endpoint)) {
    try { await sub.unsubscribe(); } catch { /* ignore */ }
    sub = null;
  }

  if (sub) {
    // Re-subscribe if VAPID key changed
    try {
      const existingKey = bytesToB64u(sub.options.applicationServerKey);
      if (existingKey && existingKey !== vapidPublicKey) {
        await sub.unsubscribe();
        sub = null;
      }
    } catch { /* fall through */ }
  }

  if (!sub) {
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return { sub: null, reason: '通知权限未授予' };
    } else if (Notification.permission === 'denied') {
      return { sub: null, reason: '通知权限已被拒绝（请到浏览器站点设置里手动开启）' };
    }
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64uToBytes(vapidPublicKey),
      });
    } catch (e) {
      console.warn('[InstantPush] pushManager.subscribe failed', e);
      return { sub: null, reason: explainSubscribeError(e) };
    }
  }

  if (isDeadEndpoint(sub.endpoint)) {
    try { await sub.unsubscribe(); } catch { /* ignore */ }
    return { sub: null, reason: '浏览器返回了 zombie endpoint（permanently-removed.invalid），无法投递' };
  }

  const p256dh = bytesToB64u(sub.getKey('p256dh'));
  const auth = bytesToB64u(sub.getKey('auth'));
  if (!p256dh || !auth) return { sub: null, reason: '订阅缺少加密公钥（p256dh / auth）' };

  return {
    sub: {
      endpoint: sub.endpoint,
      keys: { p256dh, auth },
    },
  };
}

// ── ReiClient lazy singleton ───────────────────────────────────────────────

let _cachedClient: ReiClient | null = null;
let _cachedClientKey = '';

function getClient(): ReiClient {
  const cfg = loadInstantConfig();
  const key = `${cfg.workerUrl}|${cfg.clientToken ?? ''}`;
  if (_cachedClient && _cachedClientKey === key) return _cachedClient;
  _cachedClient = new ReiClient({
    baseUrl: cfg.workerUrl,
    instantEncryption: false,
    instantClientToken: cfg.clientToken,
  });
  _cachedClientKey = key;
  return _cachedClient;
}

// ── Send helpers ───────────────────────────────────────────────────────────

export async function sendInstantPush(
  payload: InstantPushPayload,
): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  const cfg = loadInstantConfig();
  if (!isInstantConfigReady(cfg)) {
    return { ok: false, error: '请先在 Settings → Instant Push 里配置并保存' };
  }
  try {
    const client = getClient();
    const result = await client.sendInstant(payload) as { success: boolean; data?: unknown; error?: { message?: string } };
    if (result.success) return { ok: true, data: result.data };
    return { ok: false, error: result.error?.message ?? '发送失败' };
  } catch (e) {
    const err = e as { message?: string } | null;
    return { ok: false, error: err?.message ?? String(e) };
  }
}

export async function sendTestInstantPush(
  apiConfig: APIConfig,
): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  if (!apiConfig.baseUrl) {
    return { ok: false, error: '请先在 Settings → API 里配置 Chat API' };
  }

  const cfg = loadInstantConfig();
  if (!isInstantConfigReady(cfg)) {
    return { ok: false, error: '请先配置并保存 Instant Push 设置' };
  }

  const { sub, reason } = await getOrCreateInstantSubscription(cfg.vapidPublicKey);
  if (!sub) {
    return { ok: false, error: reason ?? '无法获取推送订阅' };
  }

  // amsg-instant 0.4.0+ runs normalizeAiApiUrl Worker-side; we can forward
  // apiConfig.baseUrl as-is (root / /v1 / full /chat/completions all accepted).
  return sendInstantPush({
    contactName: 'Instant Push 测试',
    completePrompt: '用一句话简短地和用户说一声 hi，确认 Instant Push 工作正常',
    apiUrl: apiConfig.baseUrl,
    apiKey: apiConfig.apiKey,
    primaryModel: apiConfig.model,
    pushSubscription: sub,
  });
}
