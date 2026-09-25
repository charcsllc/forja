/** security: flags SQL built by string concatenation; writes nothing. */
import type { EvalCase } from "../types.js";
import { check, outputOf } from "./helpers.js";

export const securityCase: EvalCase = {
  role: "security",
  id: "security-sql-injection",
  title: "Flag an SQL injection in a search route",
  input: {
    task: "Review src/app/api/search/route.ts for security issues and call submit_review.",
    files: {
      "src/app/api/search/route.ts":
        'import { sql } from "@/db/client";\n\nexport async function GET(req: Request) {\n  const q = new URL(req.url).searchParams.get("q") ?? "";\n  const rows = await sql.unsafe(`select * from products where name ilike \'%${q}%\'`);\n  return Response.json(rows);\n}\n',
    },
  },
  expect: {
    reportStatus: "done",
    filesChanged: [],
    strictScope: true,
    customCheck: async (_wd, report) => {
      const out = outputOf(report.output);
      const findings = Array.isArray(out.findings) ? (out.findings as Array<Record<string, unknown>>) : [];
      const hit = findings.some((f) => f.category === "sql-injection" && f.path === "src/app/api/search/route.ts" && f.severity === "blocking");
      return check(hit, `expected a blocking sql-injection finding, got ${JSON.stringify(out)}`);
    },
  },
  golden: {
    report: {
      status: "done",
      output: {
        verdict: "changes-requested",
        findings: [{ path: "src/app/api/search/route.ts", line: 5, category: "sql-injection", severity: "blocking", message: "User input interpolated into sql.unsafe; use a parameterised query." }],
      },
    },
  },
};
