/**
 * 原生端（Capacitor 打包的 App）用 CapacitorHttp 代替浏览器 fetch 来打 LLM 接口。
 *
 * 为什么要这玩意：
 *   纯网页（GitHub Pages / Vite dev）里，fetch 受浏览器同源策略约束——服务端不返回
 *   Access-Control-Allow-Origin 就会被预检挡死（Pioneer 这类没开 CORS 的源就是这样）。
 *   而 CapacitorHttp 走的是安卓/iOS 原生 HTTP 栈，**根本不经过 WebView 的 CORS 检查**，
 *   所以在打包后的 App 里，连没开 CORS 的源也能直连，无需任何代理服务器。
 *
 *   项目里 MiniMax / FishAudio 已经是这个套路（utils/minimaxEndpoint.ts、fishAudioTts.ts），
 *   这里把它收敛成一个「fetch 兼容」的包装，返回真正的 Response，好让上层 safeFetchJson /
 *   safeResponseJson 原样消费、不用改任何调用点。
 *
 * 只在原生端、且只对 LLM 类 JSON 接口生效；纯网页版和其它请求（图片/blob/同源资源）一律
 * 不碰，避免 CapacitorHttp 已知的二进制/流式坑。
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';

export function isNativeRuntime(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

// 命中这些「以 LLM 端点结尾」的 URL 才改走原生：chat/completions、completions、responses、
// models、embeddings。要求紧贴在路径末尾（可带 query），避免误伤 /replicate/models/owner/name
// 这种中间带 models 的地址。
const LLM_ENDPOINT_TAIL = /\/(?:chat\/completions|completions|responses|models|embeddings)(?:\?[^#]*)?$/i;

export function shouldRouteViaNativeHttp(url: string): boolean {
  if (!isNativeRuntime()) return false;
  // 只处理绝对 http(s) 跨域地址；相对路径 / 同源资源交给原生 WebView 自己处理。
  if (!/^https?:\/\//i.test(url)) return false;
  return LLM_ENDPOINT_TAIL.test(url);
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((v, k) => { out[k] = v; });
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[k] = v as string;
  } else {
    Object.assign(out, headers as Record<string, string>);
  }
  return out;
}

/**
 * fetch 兼容包装：用 CapacitorHttp 发请求，把结果还原成一个真正的 Response。
 * 仅在原生端对 LLM 接口调用（调用前用 shouldRouteViaNativeHttp 判定）。
 */
export async function nativeHttpFetch(resource: RequestInfo | URL, config?: RequestInit): Promise<Response> {
  const url = String(resource);
  const method = (config?.method || 'GET').toUpperCase();
  const headers = headersToObject(config?.headers);

  // CapacitorHttp 的 data 接受对象或字符串。JSON body 解析成对象交给原生层按 Content-Type
  // 序列化最稳；解析不了（非 JSON body）就原样塞字符串。
  let data: any = undefined;
  const rawBody = config?.body;
  if (typeof rawBody === 'string' && rawBody.length) {
    try { data = JSON.parse(rawBody); } catch { data = rawBody; }
  }

  const res = await CapacitorHttp.request({
    url,
    method,
    headers,
    data,
    // 长文本生成可能跑很久，给足读超时，别中途掐断；连接超时短一点好暴露网络问题。
    readTimeout: 600000,
    connectTimeout: 30000,
  });

  // 原生层网络失败时 CapacitorHttp 一般直接抛错；万一返回了非法 status，按网络失败处理，
  // 让上层（safeFetchJson）当成可重试的网络错误，而不是构造 Response 时崩 RangeError。
  if (!(res.status >= 200 && res.status <= 599)) {
    throw new TypeError(`native http request failed (status ${res.status})`);
  }

  // CapacitorHttp 会按 Content-Type 自动解析：JSON→对象，其它→字符串（含 SSE 整段文本）。
  // 统一还原成文本，交给 safeResponseJson —— 它既能 JSON.parse，也能把 SSE 拼成完整 completion。
  const bodyText = typeof res.data === 'string'
    ? res.data
    : (res.data == null ? '' : JSON.stringify(res.data));

  const ct = (res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || 'application/json';

  return new Response(bodyText, {
    status: res.status,
    headers: { 'content-type': String(ct) },
  });
}
