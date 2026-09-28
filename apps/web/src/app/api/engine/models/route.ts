import { forwardToEngine, notEngineResponse } from "../_engine";

export const dynamic = "force-dynamic";

/**
 * ═══ PROVIDERS AND ROLE → MODEL ASSIGNMENTS (Forja Engine only; contract C3) ═══════
 *
 *   GET /api/engine/models → GET ${engine}/v2/system/models
 *
 * Read-only, for the Settings modal. The engine never returns keys; this route still
 * copies only the documented fields, so nothing else can reach the browser. An engine
 * without the endpoint answers 404/501, which is passed through for the UI to show
 * "Model list unavailable".
 */
type ProviderRow = {
    id: string;
    kind: "llm" | "image" | "stock";
    envName: string;
    status: "enabled" | "disabled" | "misconfigured";
    adapterReady: boolean;
    models?: string[];
};

type AssignmentRow = {
    role: string;
    model: string | null;
    fallbacks: string[];
    source: "env" | "auto";
    error?: string;
};

const str = (v: unknown): v is string => typeof v === "string";
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(str).slice(0, 200) : []);

function pickModels(raw: unknown): { providers: ProviderRow[]; assignments: AssignmentRow[] } | null {
    const body = raw as { providers?: unknown; assignments?: unknown } | null;
    if (!body || !Array.isArray(body.providers) || !Array.isArray(body.assignments)) return null;
    const providers: ProviderRow[] = [];
    for (const p of body.providers as Record<string, unknown>[]) {
        if (!p || !str(p.id) || !str(p.envName)) continue;
        const kind = p.kind === "llm" || p.kind === "image" || p.kind === "stock" ? p.kind : null;
        const status = p.status === "enabled" || p.status === "disabled" || p.status === "misconfigured" ? p.status : null;
        if (!kind || !status) continue;
        providers.push({
            id: p.id,
            kind,
            envName: p.envName,
            status,
            adapterReady: p.adapterReady === true,
            ...(Array.isArray(p.models) ? { models: strings(p.models) } : {}),
        });
    }
    const assignments: AssignmentRow[] = [];
    for (const a of body.assignments as Record<string, unknown>[]) {
        if (!a || !str(a.role)) continue;
        assignments.push({
            role: a.role,
            model: str(a.model) ? a.model : null,
            fallbacks: strings(a.fallbacks),
            source: a.source === "env" ? "env" : "auto",
            ...(str(a.error) ? { error: a.error } : {}),
        });
    }
    return { providers, assignments };
}

export async function GET() {
    return notEngineResponse() ?? forwardToEngine("/models", { method: "GET" }, pickModels);
}
