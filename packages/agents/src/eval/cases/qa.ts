/** qa: an e2e test that uses accessible queries (write scope: e2e/**, tests/** add-only). */
import type { EvalCase } from "../types.js";
import { NEXT_PAGE } from "./helpers.js";

export const qaCase: EvalCase = {
  role: "qa",
  id: "qa-home-heading-e2e",
  title: "Write an e2e test for the home heading and CTA",
  input: {
    task: "Write e2e/home.spec.ts with Playwright: the home page shows the heading \"Bakery Lumen\" and an \"Order now\" button. Use role-based locators only.",
    files: { "src/app/page.tsx": NEXT_PAGE },
  },
  expect: {
    reportStatus: "done",
    filesChanged: ["e2e/home.spec.ts"],
    strictScope: true,
    filesContain: [{ path: "e2e/home.spec.ts", includes: ['from "@playwright/test"', 'getByRole("heading", { name: "Bakery Lumen" })', 'getByRole("button", { name: "Order now" })', 'page.goto("/")'] }],
    filesExclude: [{ path: "e2e/home.spec.ts", excludes: ["locator(\".", "waitForTimeout"] }],
  },
  golden: {
    files: {
      "e2e/home.spec.ts":
        'import { expect, test } from "@playwright/test";\n\ntest("home shows the heading and the CTA", async ({ page }) => {\n  await page.goto("/");\n  await expect(page.getByRole("heading", { name: "Bakery Lumen" })).toBeVisible();\n  await expect(page.getByRole("button", { name: "Order now" })).toBeVisible();\n});\n',
    },
    report: { status: "done" },
  },
};
