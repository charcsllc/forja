/** copywriter: SEO metadata within length limits (title <= 60, description <= 160). */
import type { EvalCase } from "../types.js";
import { check, readText } from "./helpers.js";

export const copywriterCase: EvalCase = {
  role: "copywriter",
  id: "copywriter-home-metadata",
  title: "Write home metadata within SEO limits",
  input: {
    task: "Fill siteMetadata in src/content/site.ts for a neighbourhood bakery called Lumen in Valencia: title <= 60 chars, description <= 160 chars, both mention the bakery name.",
    files: { "src/content/site.ts": 'export const siteMetadata = {\n  title: "",\n  description: "",\n};\n' },
  },
  expect: {
    reportStatus: "done",
    filesChanged: ["src/content/site.ts"],
    strictScope: true,
    customCheck: async (wd) => {
      const src = (await readText(wd, "src/content/site.ts")) ?? "";
      const title = /title:\s*"([^"]*)"/.exec(src)?.[1] ?? "";
      const description = /description:\s*"([^"]*)"/.exec(src)?.[1] ?? "";
      const ok = title.length > 0 && title.length <= 60 && description.length > 0 && description.length <= 160 && title.includes("Lumen") && description.includes("Lumen");
      return check(ok, `title(${title.length})=${JSON.stringify(title)} description(${description.length})`);
    },
  },
  golden: {
    files: {
      "src/content/site.ts":
        'export const siteMetadata = {\n  title: "Lumen Bakery · Sourdough and pastries in Valencia",\n  description: "Lumen is a neighbourhood bakery in Valencia: slow-fermented sourdough, seasonal pastries and coffee. Order online and pick up fresh.",\n};\n',
    },
    report: { status: "done" },
  },
};
