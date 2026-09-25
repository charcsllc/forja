/** fixer: a mechanical fix (unused import) without touching anything else. */
import type { EvalCase } from "../types.js";

const BEFORE = 'import { formatPrice, unusedHelper } from "./format";\n\nexport function label(cents: number): string {\n  return formatPrice(cents);\n}\n';

export const fixerCase: EvalCase = {
  role: "fixer",
  id: "fixer-unused-import",
  title: "Remove an unused import reported by tsc",
  input: {
    task: "tsc --noUnusedLocals reports: src/lib/x.ts(1,23): error TS6133: 'unusedHelper' is declared but its value is never read. Fix it.",
    files: {
      "src/lib/x.ts": BEFORE,
      "src/lib/format.ts": "export const formatPrice = (c: number) => `${(c / 100).toFixed(2)} €`;\nexport const unusedHelper = () => 0;\n",
    },
  },
  expect: {
    reportStatus: "done",
    filesChanged: ["src/lib/x.ts"],
    strictScope: true,
    filesContain: [{ path: "src/lib/x.ts", includes: ['import { formatPrice } from "./format";', "return formatPrice(cents);"] }],
    filesExclude: [{ path: "src/lib/x.ts", excludes: ["unusedHelper"] }],
  },
  golden: {
    files: { "src/lib/x.ts": BEFORE.replace("formatPrice, unusedHelper", "formatPrice") },
    report: { status: "done" },
  },
};
