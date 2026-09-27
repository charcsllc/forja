import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { fetchEnginePublic, getBackendKind, isValidPublicToken } from "@/lib/vcaas-server";

export const dynamic = "force-dynamic";

/**
 * ═══ THE ENGINE'S SIGNED PUBLIC FILES, SERVED FROM THIS ORIGIN ═══════════════
 *
 * The Forja Engine issues every browser-facing file URL (uploads, thumbnails, the source
 * archive) as `${APP_URL}/api/files/<token>` (docs/architecture/05 §2.3), so the engine
 * itself is never exposed. This route streams `${FORJA_ENGINE_URL}/v1/public/<token>`
 * back unchanged.
 *
 * ⚠️ NO `api-key`. The token is the authorisation (HMAC, bound to a project and a
 * resource, with its own expiry); the operator key must never ride on a request whose
 * bytes go straight to a browser.
 *
 * ⚠️ NO SSRF CHECK, ON PURPOSE: the upstream origin is fixed by configuration and the
 * only caller-controlled part is the token, which is validated to the base64url+`.`
 * alphabet before it is placed in the path. Redirects are refused and the wait is
 * bounded (60 s) like the source-code route.
 *
 * With the Totalum backend there is nothing to serve here: 404.
 */
const PASSED_THROUGH = ["content-type", "content-length", "cache-control", "content-disposition"] as const;

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ token: string }> }
) {
    if (getBackendKind() !== "engine") {
        return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }

    const { token } = await params;
    if (!isValidPublicToken(token)) {
        return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }

    let upstream: Response;
    try {
        upstream = await fetchEnginePublic(token);
    } catch {
        return NextResponse.json({ ok: false, error: "The file server did not respond" }, { status: 502 });
    }

    const headers = new Headers();
    for (const name of PASSED_THROUGH) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
    }
    // `fetch` has already decoded a compressed body, so its length no longer matches.
    if (upstream.headers.get("content-encoding")) headers.delete("content-length");
    // Uploaded files are user content served from OUR origin: never let a browser sniff
    // one into HTML, and never let an uploaded HTML/SVG document run script here.
    // (The matching `Content-Security-Policy: sandbox` is set in `src/proxy.ts`, which
    // owns CSP for every response and would overwrite one set here.)
    headers.set("x-content-type-options", "nosniff");

    return new NextResponse(upstream.body, { status: upstream.status, headers });
}
