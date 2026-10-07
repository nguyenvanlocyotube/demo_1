import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
    fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
    if (!serverEntryPromise) {
        serverEntryPromise = import("@tanstack/react-start/server-entry").then(
            (m) => (m.default ?? m) as ServerEntry,
        );
    }
    return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
    if (response.status < 500) return response;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return response;

    const body = await response.clone().text();
    if (!isH3SwallowedErrorBody(body)) return response;

    console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
    return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
    });
}

function isH3SwallowedErrorBody(body: string): boolean {
    try {
        const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
        return payload.unhandled === true && payload.message === "HTTPError";
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Log request/response ra bên thứ 3 (Groq, v.v.) — patch global fetch 1 lần.
// ---------------------------------------------------------------------------
let outboundFetchPatched = false;

function patchOutboundFetchLogging() {
    if (outboundFetchPatched) return;
    outboundFetchPatched = true;

    const originalFetch = global.fetch;

    global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        const startedAt = Date.now();

        console.log(`[outbound →] ${method} ${url}`);

        try {
            const response = await originalFetch(input, init);
            const durationMs = Date.now() - startedAt;

            if (response.status >= 400) {
                // Đọc body lỗi để biết bên thứ 3 (Groq...) từ chối vì lý do gì.
                // clone() để không "tiêu" mất body — code gọi fetch phía sau vẫn đọc được response gốc bình thường.
                const errorBody = await response.clone().text();
                console.error(
                    `[outbound ←] ${method} ${url} — ${response.status} (${durationMs}ms)\n` +
                    `  body: ${errorBody.slice(0, 2000)}`,
                );
            } else {
                console.log(
                    `[outbound ←] ${method} ${url} — ${response.status} (${durationMs}ms)`,
                );
            }

            return response;
        } catch (error) {
            const durationMs = Date.now() - startedAt;
            console.error(
                `[outbound ✗] ${method} ${url} — lỗi sau ${durationMs}ms:`,
                error,
            );
            throw error;
        }
    };
}

patchOutboundFetchLogging();

export default {
    async fetch(request: Request, env: unknown, ctx: unknown) {
        const requestId = crypto.randomUUID().slice(0, 8);
        const startedAt = Date.now();
        const { method, url } = request;

        console.log(`[in →] [${requestId}] ${method} ${url}`);

        try {
            const handler = await getServerEntry();
            const response = await handler.fetch(request, env, ctx);
            const normalized = await normalizeCatastrophicSsrResponse(response);

            const durationMs = Date.now() - startedAt;
            console.log(
                `[in ←] [${requestId}] ${method} ${url} — ${normalized.status} (${durationMs}ms)`,
            );

            return normalized;
        } catch (error) {
            const durationMs = Date.now() - startedAt;
            console.error(
                `[in ✗] [${requestId}] ${method} ${url} — lỗi sau ${durationMs}ms:`,
                error,
            );
            return new Response(renderErrorPage(), {
                status: 500,
                headers: { "content-type": "text/html; charset=utf-8" },
            });
        }
    },
};