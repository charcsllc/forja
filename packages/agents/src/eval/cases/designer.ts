/** designer: turn a brief into design tokens in globals.css (write scope: globals.css). */
import type { EvalCase } from "../types.js";

export const designerCase: EvalCase = {
  role: "designer",
  id: "designer-tokens-from-brief",
  title: "Define brand tokens from the design brief",
  input: {
    task: "Read docs/design/brief.md and define --brand, --surface and --ink tokens in src/app/globals.css under :root. Keep the existing import.",
    files: {
      "docs/design/brief.md": "# Brief\n\nBrand colour: deep blue #1d4ed8. Surfaces: warm off-white #faf7f2. Text: near-black #111827.\n",
      "src/app/globals.css": '@import "tailwindcss";\n',
    },
  },
  expect: {
    reportStatus: "done",
    filesChanged: ["src/app/globals.css"],
    strictScope: true,
    filesContain: [{ path: "src/app/globals.css", includes: ['@import "tailwindcss";', ":root", "--brand: #1d4ed8", "--surface: #faf7f2", "--ink: #111827"] }],
  },
  golden: {
    files: { "src/app/globals.css": '@import "tailwindcss";\n\n:root {\n  --brand: #1d4ed8;\n  --surface: #faf7f2;\n  --ink: #111827;\n}\n' },
    report: { status: "done", summary: "Added brand, surface and ink tokens." },
  },
};
