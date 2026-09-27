import { NextResponse } from "next/server";
import { isDatabaseReachable } from "@/db/queries/health";
import packageJson from "../../../../package.json";

export const dynamic = "force-dynamic";

/** Liveness + readiness: `{ ok, db, version }`. 503 when the database does not answer. */
export async function GET() {
  const db = await isDatabaseReachable();
  return NextResponse.json(
    { ok: db, db: db ? "ok" : "unreachable", version: packageJson.version },
    { status: db ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
