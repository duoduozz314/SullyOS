/**
 * API 兼容性补丁（浏览器端 fetch 拦截器）。
 * 文件名保留 anthropicDirectAccess 以免改动 index.tsx 的 import。
 *
 * 【Anthropic 官方 API】(api.anthropic.com)
 * 1. CORS：补 `anthropic-dangerous-direct-browser-access: true`，
 *    否则浏览器直连预检被拒（"Load failed"）。
 * 2. 纯 system 消息：Anthropic 要求至少一条 user 消息，把最后一条
 *    system 转成 user 角色，内容不变。
 *
 * 【OpenAI 官方 API】(api.openai.com)
 * 3. GPT-5 / o 系列参数迁移：这些模型不接受 max_tokens（要求
 *    max_completion_tokens），也不接受自定义 temperature / top_p
 *    （只允许默认值）。自动改名 + 删掉不支持的采样参数。
 *    仅对官方域名生效——中转站通常自带转换，不去干扰。
 *
 * 在 index.tsx 最顶部调用 installAnthropicDirectAccess() 即可。
 */

const ANTHROPIC_HOST = /(^|\.)anthropic\.com$/i;
const OPENAI_HOST = /(^|\.)openai\.com$/i;
const HEADER_NAME = 'anthropic-dangerous-direct-browser-access';
// GPT-5 家族与 o 系列推理模型（o1/o3/o4...）
const NEW_PARAM_MODELS = /^(gpt-5|o\d)/i;

function getUrl(input: RequestInfo | URL): string {
    return typeof input === 'string'
        ? input
        : input instanceof URL
            ? input.href
            : input.url;
}

function getHostname(input: RequestInfo | URL): string {
    try {
        return new URL(getUrl(input), window.location.href).hostname;
    } catch {
        return '';
    }
}

/** Anthropic：纯 system 消息 → 最后一条转 user。无需修补返回 null。 */
function fixSystemOnlyBody(rawBody: unknown): string | null {
    if (typeof rawBody !== 'string' || !rawBody) return null;
    try {
        const payload = JSON.parse(rawBody);
        const msgs = payload?.messages;
        if (!Array.isArray(msgs) || msgs.length === 0) return null;
        const allSystem = msgs.every(
            (m: any) => m?.role === 'system' || m?.role === 'developer'
        );
        if (!allSystem) return null;
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], role: 'user' };
        return JSON.stringify(payload);
    } catch {
        return null;
    }
}

/** OpenAI：GPT-5/o 系列参数迁移。无需修补返回 null。 */
function fixOpenAINewModelBody(rawBody: unknown): string | null {
    if (typeof rawBody !== 'string' || !rawBody) return null;
    try {
        const payload = JSON.parse(rawBody);
        if (!NEW_PARAM_MODELS.test(String(payload?.model || ''))) return null;

        let changed = false;
        if ('max_tokens' in payload) {
            if (!('max_completion_tokens' in payload)) {
                payload.max_completion_tokens = payload.max_tokens;
            }
            delete payload.max_tokens;
            changed = true;
        }
        // 这些模型只接受默认采样参数，带了就 400
        for (const k of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'logprobs', 'logit_bias']) {
            if (k in payload) {
                delete payload[k];
                changed = true;
            }
        }
        return changed ? JSON.stringify(payload) : null;
    } catch {
        return null;
    }
}

export function installAnthropicDirectAccess(): void {
    if (typeof window === 'undefined' || !window.fetch) return;
    if ((window as any).__anthropicDirectAccessInstalled) return;
    (window as any).__anthropicDirectAccessInstalled = true;

    const originalFetch = window.fetch.bind(window);

    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const host = getHostname(input);
        const isAnthropic = ANTHROPIC_HOST.test(host);
        const isOpenAI = OPENAI_HOST.test(host);
        if (!isAnthropic && !isOpenAI) {
            return originalFetch(input, init);
        }

        const headers = new Headers(
            init?.headers ??
            (input instanceof Request ? input.headers : undefined)
        );
        let body = init?.body;
        const isChat = getUrl(input).includes('/chat/completions');

        if (isAnthropic) {
            if (!headers.has(HEADER_NAME)) headers.set(HEADER_NAME, 'true');
            if (isChat) {
                const fixed = fixSystemOnlyBody(body);
                if (fixed !== null) body = fixed;
            }
        }

        if (isOpenAI && isChat) {
            const fixed = fixOpenAINewModelBody(body);
            if (fixed !== null) body = fixed;
        }

        return originalFetch(input, { ...init, headers, body });
    };
}
