import { NextRequest, NextResponse } from "next/server";
import { vcaasUploadRequest } from "@/lib/vcaas-server";

/**
 * ═══ THE MULTIPART UPLOAD PROXY ═════════════════════════════════════════════
 *
 * ⚠️ IT MUST REPORT WHY AN UPLOAD FAILED, NOT JUST THAT IT DID. This route used to
 * answer a flat `500 "Upload failed"` for everything, which hid a real and very common
 * failure: a reverse proxy in front of the API rejects a body over ~1 MB with a plain
 * **nginx 413 HTML page**, long before the API's own 12 MB limit is consulted. Most
 * phone photos are over 1 MB. The caller retried three times, got the same opaque 500,
 * and dropped the file with no message — so attaching four photos silently attached
 * only the small ones.
 *
 * Two things follow from that, and both matter:
 *
 *  1. **The upstream status is forwarded**, so the caller can tell "too big" (never
 *     going to work, do not retry) from "the server hiccupped" (worth a retry).
 *  2. **A non-JSON body is handled.** The 413 is HTML from nginx, not the API's
 *     `{ errors, data }` envelope, so parsing it as JSON throws — which is exactly how
 *     this became an unexplained 500 in the first place.
 */

/**
 * Turn an upstream refusal into something a person can act on.
 *
 * ⚠️ THE API'S OWN WORDS WIN WHENEVER IT SENT ANY. Its `FILE_TOO_LARGE` names the real
 * limit and explains the way round it (host the file and pass its URL). The fallbacks
 * below are only for a refusal that never reached the API — nginx's HTML 413, above all,
 * which carries no message at all.
 */
function messageForStatus(status: number, upstream: string | null): string {
    if (upstream) return upstream;
    if (status === 413) return "That file is too large to upload.";
    if (status === 402) return "Not enough credits to upload this file.";
    if (status === 403 || status === 401) return "This project does not accept uploads with the current key.";
    return `Upload failed (${status}).`;
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ projectId: string }> }
) {
    try {
        const { projectId } = await params;

        // Forward the multipart form data straight through to the VCaaS endpoint.
        const formData = await req.formData();
        const response = await vcaasUploadRequest(
            `/projects/${projectId}/files/upload`,
            formData
        );

        // ⚠️ READ AS TEXT FIRST. An intermediary's error page is not JSON.
        const raw = await response.text();
        let json: { errors: { errorCode: string; errorMessage: string } | null; data?: unknown } | null = null;
        try {
            json = JSON.parse(raw) as typeof json;
        } catch {
            json = null;
        }

        if (!response.ok || !json || json.errors) {
            const upstream = json?.errors?.errorMessage ?? null;
            return NextResponse.json(
                {
                    ok: false,
                    error: messageForStatus(response.status, upstream),
                    code: json?.errors?.errorCode ?? (response.status === 413 ? "FILE_TOO_LARGE" : "UPLOAD_FAILED"),
                    /** Lets the caller skip a retry that cannot possibly succeed. */
                    retryable: response.status >= 500 || response.status === 429,
                },
                { status: response.status === 200 ? 400 : response.status }
            );
        }

        return NextResponse.json({ ok: true, data: json.data });
    } catch (err) {
        return NextResponse.json(
            {
                ok: false,
                error: err instanceof Error ? err.message : "Upload failed",
                code: "UPLOAD_FAILED",
                retryable: true,
            },
            { status: 500 }
        );
    }
}
