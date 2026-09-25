/** director: intent classification (03 §2). "cambia el color del botón" is a tweak, not a feature. */
import type { EvalCase } from "../types.js";
import { check, NEXT_PAGE, outputOf } from "./helpers.js";

export const directorCase: EvalCase = {
  role: "director",
  id: "director-intent-tweak",
  title: "Classify a one-line colour change as a tweak",
  input: {
    task: 'Classify the user prompt with submit_intent. User prompt (Spanish): "cambia el color del botón a azul".',
    files: { "src/app/page.tsx": NEXT_PAGE },
  },
  expect: {
    reportStatus: "done",
    filesChanged: [],
    strictScope: true,
    customCheck: async (_wd, report) => {
      const out = outputOf(report.output);
      return check(out.intent === "tweak" && typeof out.confidence === "number" && out.confidence >= 0.6, `expected intent tweak with confidence >= 0.6, got ${JSON.stringify(out)}`);
    },
  },
  golden: { report: { status: "done", output: { intent: "tweak", confidence: 0.93, language: "es" } } },
};
