/** supervisor: surface env needs from implementer reports in .env.example, never a value. */
import type { EvalCase } from "../types.js";

export const supervisorCase: EvalCase = {
  role: "supervisor",
  id: "supervisor-env-needs",
  title: "Declare STRIPE_SECRET_KEY in .env.example from a backend report",
  input: {
    task: 'The backend report lists envNeeds: [{ name: "STRIPE_SECRET_KEY", description: "Stripe secret key for checkout" }]. Add it to .env.example with an empty value and a comment, and report it in secretKeysNeeded.',
    files: { ".env.example": "DATABASE_URL=postgres://app:app@db:5432/app\n" },
  },
  expect: {
    reportStatus: "done",
    filesChanged: [".env.example"],
    strictScope: true,
    filesContain: [{ path: ".env.example", includes: ["DATABASE_URL=", "STRIPE_SECRET_KEY=\n", "# Stripe"] }],
    filesExclude: [{ path: ".env.example", excludes: ["sk_live_", "sk_test_"] }],
  },
  golden: {
    files: { ".env.example": "DATABASE_URL=postgres://app:app@db:5432/app\n# Stripe secret key for checkout\nSTRIPE_SECRET_KEY=\n" },
    report: { status: "done", output: { secretKeysNeeded: { STRIPE_SECRET_KEY: { isProvided: false, description: "Stripe secret key for checkout" } } } },
  },
};
