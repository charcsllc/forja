import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { forwardToEngine, notEngineResponse } from "../_engine";

export const dynamic = "force-dynamic";

/**
 * ═══ INSTANCE SETTINGS (Forja Engine only; contract C4, 05 §3) ════════════════
 *
 *   GET    /api/engine/settings                → GET    ${engine}/v2/system/settings
 *   PUT    /api/engine/settings  {images:{mode}} → PUT  ${engine}/v2/system/settings
 *   DELETE /api/engine/settings?reset=images   → DELETE ${engine}/v2/system/settings/images
 *
 * `images.mode` is the UI override of `IMAGES_FROM_WEB_SEARCH`; DELETE goes back to the
 * env. The body is validated here before it reaches the engine (which validates again),
 * and only the documented fields of the answer are passed to the browser.
 */
const MODES = new Set(["web-search", "generate"]);

type ImagesSetting = {
    mode: "web-search" | "generate";
    source: "ui" | "env";
    envDefault: "web-search" | "generate";
    generationAvailable: boolean;
};

function pickSettings(raw: unknown): { images: ImagesSetting } | null {
    const images = (raw as { images?: Record<string, unknown> } | null)?.images;
    if (!images || typeof images !== "object") return null;
    const { mode, source, envDefault, generationAvailable } = images;
    if (typeof mode !== "string" || !MODES.has(mode)) return null;
    if (typeof envDefault !== "string" || !MODES.has(envDefault)) return null;
    if (source !== "ui" && source !== "env") return null;
    return {
        images: {
            mode: mode as ImagesSetting["mode"],
            source,
            envDefault: envDefault as ImagesSetting["envDefault"],
            generationAvailable: generationAvailable === true,
        },
    };
}

export async function GET() {
    return notEngineResponse() ?? forwardToEngine("/settings", { method: "GET" }, pickSettings);
}

export async function PUT(request: NextRequest) {
    const refused = notEngineResponse();
    if (refused) return refused;
    const body = (await request.json().catch(() => null)) as { images?: { mode?: unknown } } | null;
    const mode = body?.images?.mode;
    if (typeof mode !== "string" || !MODES.has(mode)) {
        return NextResponse.json(
            { ok: false, error: 'Body must be {"images":{"mode":"web-search"|"generate"}}', code: "VALIDATION", data: null },
            { status: 400 }
        );
    }
    return forwardToEngine("/settings", { method: "PUT", body: { images: { mode } } }, pickSettings);
}

export async function DELETE(request: NextRequest) {
    const refused = notEngineResponse();
    if (refused) return refused;
    if (request.nextUrl.searchParams.get("reset") !== "images") {
        return NextResponse.json({ ok: false, error: "Say what to reset: ?reset=images", code: "VALIDATION", data: null }, { status: 400 });
    }
    return forwardToEngine("/settings/images", { method: "DELETE" }, pickSettings);
}
