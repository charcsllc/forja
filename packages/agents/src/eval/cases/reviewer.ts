/** reviewer: finds a pagination off-by-one in a diff; writes nothing. */
import type { EvalCase } from "../types.js";
import { check, outputOf } from "./helpers.js";

export const reviewerCase: EvalCase = {
  role: "reviewer",
  id: "reviewer-offset-bug",
  title: "Block a diff with an off-by-one pagination offset",
  input: {
    task: "Review .forja/diff.patch against the spec in docs/spec.md and call submit_review.",
    files: {
      "docs/spec.md": "Products are listed 20 per page; page numbers start at 1.\n",
      ".forja/diff.patch":
        "--- a/src/modules/catalog/application/list-products.ts\n+++ b/src/modules/catalog/application/list-products.ts\n@@ -1,3 +1,5 @@\n+const PAGE_SIZE = 20;\n export async function listProducts(page: number) {\n-  return db.select().from(products).limit(20);\n+  return db.select().from(products).limit(PAGE_SIZE).offset(page * PAGE_SIZE);\n }\n",
    },
  },
  expect: {
    reportStatus: "done",
    filesChanged: [],
    strictScope: true,
    customCheck: async (_wd, report) => {
      const out = outputOf(report.output);
      const findings = Array.isArray(out.findings) ? (out.findings as Array<Record<string, unknown>>) : [];
      const hit = findings.some((f) => f.path === "src/modules/catalog/application/list-products.ts" && f.severity === "blocking");
      return check(out.verdict === "changes-requested" && hit, `expected a blocking finding on list-products.ts, got ${JSON.stringify(out)}`);
    },
  },
  golden: {
    report: {
      status: "done",
      output: {
        verdict: "changes-requested",
        findings: [{ path: "src/modules/catalog/application/list-products.ts", line: 3, severity: "blocking", message: "Pages start at 1: offset must be (page - 1) * PAGE_SIZE; page 1 currently skips the first 20 products." }],
      },
    },
  },
};
