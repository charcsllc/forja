/** summarizer: compaction keeps decisions and open items, and is much shorter. */
import type { EvalCase } from "../types.js";
import { check, outputOf } from "./helpers.js";

const TRANSCRIPT = [
  "user: Build a site for my bakery Lumen in Valencia.",
  "assistant: I will plan a home, a menu and a contact page. Question: do you want online orders?",
  "user: Yes, pickup only, no delivery. Pay in store.",
  "assistant: Decision: orders table in Postgres with pickup slots; no payments integration.",
  "tool(write_file): src/db/schema.ts (orders, pickup_slots)",
  "tool(bash): npm run db:migrate → ok",
  "assistant: Home and menu done. The contact page is pending: waiting for the shop's phone number.",
  "user: Also the brand colour should be teal, #0f766e.",
  "assistant: Decision: brand colour #0f766e, updated tokens in globals.css.",
  "tool(bash): npm run build → ok",
].join("\n");

export const summarizerCase: EvalCase = {
  role: "summarizer",
  id: "summarizer-compaction",
  title: "Compact a transcript into a handoff summary",
  input: {
    task: "Summarise .forja/transcript.txt for context compaction with submit_summary: decisions, done work, open items. At most a third of the original length.",
    files: { ".forja/transcript.txt": TRANSCRIPT },
  },
  expect: {
    reportStatus: "done",
    filesChanged: [],
    strictScope: true,
    customCheck: async (_wd, report) => {
      const summary = typeof outputOf(report.output).summary === "string" ? (outputOf(report.output).summary as string) : "";
      const facts = ["pickup", "Postgres", "#0f766e", "contact", "phone"];
      const missing = facts.filter((f) => !summary.toLowerCase().includes(f.toLowerCase()));
      const short = summary.length > 0 && summary.length <= TRANSCRIPT.length / 3;
      return check(missing.length === 0 && short, `missing facts: ${missing.join(", ") || "none"}; length ${summary.length}/${TRANSCRIPT.length}`);
    },
  },
  golden: {
    report: {
      status: "done",
      output: { summary: "Lumen bakery site. Orders: pickup only, pay in store; Postgres orders + pickup_slots migrated. Brand #0f766e. Done: home, menu, build ok. Open: contact page needs the shop phone." },
    },
  },
};
