/**
 * Request-level routing (Next.js 16 `proxy`, formerly middleware). Pass-through for now:
 * add locale detection, redirects or coarse auth gating here. Authorisation still belongs to
 * each use case. Owned by the frontend role.
 */
import { NextResponse, type NextRequest } from "next/server";

export function proxy(_request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|sitemap.xml).*)"],
};
