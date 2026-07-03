/**
 * Anthropic 官方 API 浏览器直连补丁。
 *
 * 背景：浏览器里直接 fetch api.anthropic.com 会被 Anthropic 的 CORS
 * 策略拦截（预检失败，WebKit 报 "Load failed"）。官方要求浏览器端
 * 请求必须带上 `anthropic-dangerous-direct-browser-access: true`
 * 这个 header 才放行。
 *
 * 本模块包装 window.fetch：仅当请求目标是 anthropic.com 域名时补上
 * 该 header，对 OpenAI / Gemini / 各类中转站的请求零影响（不添加
 * 非标准 header，避免触发别家服务器不认的预检）。
 *
 * 在 index.tsx 最顶部调用 installAnthropicDirectAccess() 即可，
 * 必须在任何 AI 请求发出之前装载。
 */

const ANTHROPIC_HOST = /(^|\.)anthropic\.com$/i;
const HEADER_NAME = 'anthropic-dangerous-direct-browser-access';

function isAnthropicUrl(input: RequestInfo | URL): boolean {
    try {
        const url =
            typeof input === 'string'
                ? input
                : input instanceof URL
                    ? input.href
                    : input.url;
        return ANTHROPIC_HOST.test(new URL(url, window.location.href).hostname);
    } catch {
        return false;
    }
}

export function installAnthropicDirectAccess(): void {
    if (typeof window === 'undefined' || !window.fetch) return;
    // 防止重复装载（热更新 / 多次 import）
    if ((window as any).__anthropicDirectAccessInstalled) return;
    (window as any).__anthropicDirectAccessInstalled = true;

    const originalFetch = window.fetch.bind(window);

    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        if (!isAnthropicUrl(input)) {
            return originalFetch(input, init);
        }

        // 统一把 headers 归一成 Headers 再补字段，
        // 兼容 init.headers 是 Headers / 数组 / 普通对象三种形态，
        // 也兼容 headers 挂在 Request 对象上的情况。
        const headers = new Headers(
            init?.headers ??
            (input instanceof Request ? input.headers : undefined)
        );
        if (!headers.has(HEADER_NAME)) {
            headers.set(HEADER_NAME, 'true');
        }

        return originalFetch(input, { ...init, headers });
    };
}
