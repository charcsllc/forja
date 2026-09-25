/** docs: a changelog entry under Unreleased, nothing else touched. */
import type { EvalCase } from "../types.js";
import { check, readText } from "./helpers.js";

export const docsCase: EvalCase = {
  role: "docs",
  id: "docs-changelog-entry",
  title: "Add a CHANGELOG entry for the new /pricing page",
  input: {
    task: "The run added a /pricing page with three tiers. Add one line under ## Unreleased in CHANGELOG.md. Do not touch released sections.",
    files: { "CHANGELOG.md": "# Changelog\n\n## Unreleased\n\n## 0.1.0\n\n- First release.\n" },
  },
  expect: {
    reportStatus: "done",
    filesChanged: ["CHANGELOG.md"],
    strictScope: true,
    filesContain: [{ path: "CHANGELOG.md", includes: ["## Unreleased", "/pricing", "## 0.1.0\n\n- First release.\n"] }],
    customCheck: async (wd) => {
      const md = (await readText(wd, "CHANGELOG.md")) ?? "";
      const unreleased = md.slice(md.indexOf("## Unreleased"), md.indexOf("## 0.1.0"));
      return check(unreleased.includes("/pricing"), "the entry is not inside the Unreleased section");
    },
  },
  golden: {
    files: { "CHANGELOG.md": "# Changelog\n\n## Unreleased\n\n- Add a /pricing page with Starter, Pro and Team tiers.\n\n## 0.1.0\n\n- First release.\n" },
    report: { status: "done" },
  },
};
