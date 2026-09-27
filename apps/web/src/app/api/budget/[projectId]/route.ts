import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { engineRequest, getBackendKind, VcaasPathError } from "@/lib/vcaas-server";
import { isRoutableProjectSlug } from "@/lib/project-slug";

export const dynamic = "force-dynamic";

/**
 * ═══ BUDGET OF ONE PROJECT (Forja Engine only) ═══════════════════════════════
 *
 * Proxies `GET ${FORJA_ENGINE_URL}/v2/projects/<id>/budget` with the operator key and
 * returns `{ok:true, data}` (v2 is plain JSON, 05 §3). Shape expected from the engine,
 * mirrored by `BudgetReport` in `app/project/[projectId]/budget/page.tsx`:
 *
 *   { project: { monthSpentUsd, monthBudgetUsd | null },
 *     runs:    [{ id, startedAt, status, spentUsd, budgetUsd }],
 *     global:  { monthSpentUsd, monthBudgetUsd | null } }
 *
 * With the Totalum backend there is no budget (it bills in credits): 404 with
 * `code: "NOT_AVAILABLE"`, which the page renders as an explanation, not an error.
 */
export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ projectId: string }> }
) {
    if (getBackendKind() !== "engine") {
        return NextResponse.json(
            { ok: false, error: "Budgets are only available with the Forja Engine", code: "NOT_AVAILABLE", data: null },
            { status: 404 }
        );
    }

    const { projectId } = await params;
    if (!isRoutableProjectSlug(projectId)) {
        return NextResponse.json({ ok: false, error: "Project not found", code: "PROJECT_NOT_FOUND", data: null }, { status: 404 });
    }

    try {
        const res = await engineRequest(`/v2/projects/${encodeURIComponent(projectId)}`, "/budget", {
            method: "GET",
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.timeout(20_000),
        });
        const json = (await res.json().catch(() => null)) as
            | { data?: unknown; errors?: { errorCode?: string; errorMessage?: string } | null; error?: string }
            | null;

        if (!res.ok || !json || json.errors) {
            const code = json?.errors?.errorCode ?? (res.status === 404 ? "PROJECT_NOT_FOUND" : "UNKNOWN");
            const error = json?.errors?.errorMessage ?? json?.error ?? `The engine answered HTTP ${res.status}`;
            return NextResponse.json(
                { ok: false, error, code, data: null },
                { status: res.ok ? 502 : res.status }
            );
        }

        // Accept both a plain object and an envelope that wraps it in `data`.
        const data = json && typeof json === "object" && "data" in json && json.data ? json.data : json;
        return NextResponse.json({ ok: true, data }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
        if (error instanceof VcaasPathError) {
            return NextResponse.json({ ok: false, error: "Invalid path", code: "VALIDATION", data: null }, { status: 400 });
        }
        console.error("[budget] engine request failed:", error instanceof Error ? error.message : error);
        return NextResponse.json(
            { ok: false, error: "The engine did not respond", code: "UNKNOWN", data: null },
            { status: 502 }
        );
    }
}
