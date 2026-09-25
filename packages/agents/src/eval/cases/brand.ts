/** brand: a valid SVG monogram favicon in the brand colour. */
import type { EvalCase } from "../types.js";
import { check, readText } from "./helpers.js";

export const brandCase: EvalCase = {
  role: "brand",
  id: "brand-monogram-icon",
  title: "Create a monogram icon.svg",
  input: {
    task: 'Create src/app/icon.svg: a square monogram "L" on the brand colour #0f766e, text converted to a path (no <text>), viewBox 0 0 32 32.',
    files: { "docs/brand/guide.md": "Name: Lumen. Brand colour #0f766e. Monogram letter: L.\n" },
  },
  expect: {
    reportStatus: "done",
    filesChanged: ["src/app/icon.svg"],
    strictScope: true,
    filesContain: [{ path: "src/app/icon.svg", includes: ["<svg", 'viewBox="0 0 32 32"', "#0f766e", "<path"] }],
    filesExclude: [{ path: "src/app/icon.svg", excludes: ["<text", "<script"] }],
    customCheck: async (wd) => {
      const svg = (await readText(wd, "src/app/icon.svg")) ?? "";
      return check(svg.trim().endsWith("</svg>") && svg.length < 4096, "icon must be a closed, small (<4 KB) SVG");
    },
  },
  golden: {
    files: {
      "src/app/icon.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0f766e"/><path d="M11 8h3v13h8v3H11z" fill="#fff"/></svg>\n',
    },
    report: { status: "done" },
  },
};
