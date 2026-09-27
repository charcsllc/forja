import { NextResponse } from "next/server";
import { assertSafeName, getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|video\/|audio\/|application\/pdf)/;

/**
 * Serves stored files by name (`{ name }` of *_file / *_image fields). Names are random
 * UUIDs, so possession of the URL is the capability. For private files, add an ownership
 * check here before streaming.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ name: string[] }> }) {
  const name = (await params).name.join("/");
  try {
    assertSafeName(name);
  } catch {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  }

  const file = await getStorage().get(name);
  if (!file) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });

  const headers = new Headers({
    "content-type": file.contentType,
    "x-content-type-options": "nosniff",
    "cache-control": "public, max-age=31536000, immutable",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "content-disposition": INLINE.test(file.contentType) ? "inline" : "attachment",
  });
  if (file.size !== undefined) headers.set("content-length", String(file.size));
  return new Response(file.body, { headers });
}
