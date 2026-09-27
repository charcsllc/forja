/** frontend: a page rendered from content data, not hardcoded copy. */
import type { EvalCase } from "../types.js";
import { check, readText } from "./helpers.js";

export const frontendCase: EvalCase = {
  role: "frontend",
  id: "frontend-pricing-page",
  title: "Add a /pricing page with three tiers from src/content/pricing.ts",
  input: {
    task: "Add src/app/pricing/page.tsx rendering the three tiers exported by src/content/pricing.ts (name, price, features). Import the data; do not copy the copy. Use a <ul> per tier for features.",
    files: {
      "src/content/pricing.ts":
        'export const tiers = [\n  { name: "Starter", price: "9 €", features: ["1 site", "Email support"] },\n  { name: "Pro", price: "29 €", features: ["5 sites", "Priority support"] },\n  { name: "Team", price: "79 €", features: ["Unlimited sites", "SSO"] },\n] as const;\n',
      "src/app/page.tsx": "export default function Home() {\n  return <main>Home</main>;\n}\n",
    },
  },
  expect: {
    reportStatus: "done",
    filesChanged: ["src/app/pricing/page.tsx"],
    filesContain: [{ path: "src/app/pricing/page.tsx", includes: ["export default function", 'from "@/content/pricing"', "tiers.map(", "<ul"] }],
    customCheck: async (wd) => {
      const page = await readText(wd, "src/app/pricing/page.tsx");
      if (page === undefined) return check(false, "page missing");
      const hardcoded = ["Starter", "Priority support", "79 €"].filter((s) => page.includes(s));
      return check(hardcoded.length === 0, `copy hardcoded in the page: ${hardcoded.join(", ")}`);
    },
  },
  golden: {
    files: {
      "src/app/pricing/page.tsx":
        'import { tiers } from "@/content/pricing";\n\nexport default function PricingPage() {\n  return (\n    <main className="mx-auto grid max-w-5xl gap-6 p-8 md:grid-cols-3">\n      {tiers.map((tier) => (\n        <section key={tier.name} className="rounded-xl border p-6">\n          <h2 className="text-xl font-semibold">{tier.name}</h2>\n          <p className="text-3xl">{tier.price}</p>\n          <ul>\n            {tier.features.map((f) => (\n              <li key={f}>{f}</li>\n            ))}\n          </ul>\n        </section>\n      ))}\n    </main>\n  );\n}\n',
    },
    report: { status: "done" },
  },
};
