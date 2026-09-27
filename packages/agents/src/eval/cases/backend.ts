/** backend: a Next.js 16 route handler. */
import type { EvalCase } from "../types.js";

export const backendCase: EvalCase = {
  role: "backend",
  id: "backend-health-route",
  title: "Add GET /api/health",
  input: {
    task: "Add a route handler at src/app/api/health/route.ts: GET returns JSON { ok: true } with status 200 and is never cached (export const dynamic = \"force-dynamic\").",
    files: { "package.json": '{ "name": "lumen", "dependencies": { "next": "16.3.4" } }\n' },
  },
  expect: {
    reportStatus: "done",
    filesChanged: ["src/app/api/health/route.ts"],
    strictScope: true,
    filesContain: [{ path: "src/app/api/health/route.ts", includes: ["export async function GET", "Response.json({ ok: true })", 'export const dynamic = "force-dynamic"'] }],
  },
  golden: {
    files: { "src/app/api/health/route.ts": 'export const dynamic = "force-dynamic";\n\nexport async function GET() {\n  return Response.json({ ok: true });\n}\n' },
    report: { status: "done" },
  },
};
