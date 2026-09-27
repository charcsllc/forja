import { NextResponse } from "next/server";
import { getBackendKind, getBackendPublicConfig, getVcaasApiKey } from "@/lib/vcaas-server";

export const dynamic = "force-dynamic";

// Reports whether the backend key is configured — WITHOUT ever exposing the key itself
// to the client — plus which backend answers (`engine` when FORJA_ENGINE_URL is set,
// otherwise `totalum`) and the public URL shape of published apps and previews. The
// dashboard uses `configured` to show setup guidance; the workspace uses the rest to
// build publish links (`useBackendConfig`).
export async function GET() {
  const backend = getBackendKind();
  const { publishScheme, publishDomain, previewDomain } = await getBackendPublicConfig();
  return NextResponse.json({
    ok: true,
    data: {
      configured: getVcaasApiKey().trim().length > 0,
      backend,
      publishScheme,
      publishDomain,
      previewDomain,
    },
  });
}
