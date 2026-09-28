import { NextResponse } from "next/server";

import { engineRequest, getBackendKind, VcaasPathError } from "@/lib/vcaas-server";

/**
 * ═══ SERVER-ONLY HELPER FOR THE `/api/engine/*` ROUTES (Forja Engine only) ═══════
 *
 * ⚠️ NEVER IMPORT THIS FROM A CLIENT COMPONENT: it reaches `vcaas-server`, which reads
 * the engine key. The key is added by `engineRequest` and never leaves this process.
 *
 * Every answer is the builder's envelope, `{ok:true, data}` or `{ok:false, error, code,
 * data:null}`. The engine's v2 error shape (`{error:{code,message}}`) is unwrapped; a 5xx
 * becomes 502 like the rest of the proxy. With Totalum there is no engine: 404
 * `NOT_AVAILABLE`, which the UI renders as "not available", not as an error.
 *
 * The caller passes a `pick` that copies only the fields the UI needs, so an engine that
 * one day returns more (or something it should not) cannot leak it to the browser.
 */
export function notEngineResponse(): NextResponse | null {
    if (getBackendKind() === "engine") return null;
    return NextResponse.json(
        { ok: false, error: "Only available with the Forja Engine", code: "NOT_AVAILABLE", data: null },
        { status: 404 }
    );
}

export async function forwardToEngine<T>(
    path: string,
    init: { method: "GET" | "PUT" | "DELETE"; body?: unknown },
    pick: (raw: unknown) => T | null
): Promise<NextResponse> {
    try {
        const res = await engineRequest("/v2/system", path, {
            method: init.method,
            headers: init.body === undefined ? undefined : { "content-type": "application/json" },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.timeout(15_000),
        });
        const json = (await res.json().catch(() => null)) as
            | { error?: { code?: string; message?: string } | string }
            | null;

        if (!res.ok) {
            const err = json && typeof json.error === "object" ? json.error : null;
            return NextResponse.json(
                {
                    ok: false,
                    error: err?.message ?? `The engine answered HTTP ${res.status}`,
                    code: err?.code ?? (res.status === 404 ? "NOT_FOUND" : "UNKNOWN"),
                    data: null,
                },
                { status: res.status >= 500 && res.status !== 501 ? 502 : res.status }
            );
        }

        const data = pick(json);
        if (data === null) {
            return NextResponse.json(
                { ok: false, error: "The engine answered with an unexpected shape", code: "UNKNOWN", data: null },
                { status: 502 }
            );
        }
        return NextResponse.json({ ok: true, data }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
        if (error instanceof VcaasPathError) {
            return NextResponse.json({ ok: false, error: "Invalid path", code: "VALIDATION", data: null }, { status: 400 });
        }
        console.error("[engine] request failed:", error instanceof Error ? error.message : error);
        return NextResponse.json(
            { ok: false, error: "The engine did not respond", code: "UNKNOWN", data: null },
            { status: 502 }
        );
    }
}
