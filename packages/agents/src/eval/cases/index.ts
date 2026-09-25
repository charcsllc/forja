/**
 * The golden set: exactly one case per role. Protects: `CASES` covers all 15 roles
 * (asserted in tests), so `agents:eval -- <role>` always has something to run.
 */
import type { EvalCase } from "../types.js";
import { backendCase } from "./backend.js";
import { brandCase } from "./brand.js";
import { copywriterCase } from "./copywriter.js";
import { databaseCase } from "./database.js";
import { designerCase } from "./designer.js";
import { directorCase } from "./director.js";
import { docsCase } from "./docs.js";
import { fixerCase } from "./fixer.js";
import { frontendCase } from "./frontend.js";
import { imageryCase } from "./imagery.js";
import { qaCase } from "./qa.js";
import { reviewerCase } from "./reviewer.js";
import { securityCase } from "./security.js";
import { summarizerCase } from "./summarizer.js";
import { supervisorCase } from "./supervisor.js";

export const CASES: EvalCase[] = [
  directorCase, designerCase, brandCase, imageryCase, copywriterCase, databaseCase, backendCase, frontendCase,
  supervisorCase, qaCase, reviewerCase, securityCase, docsCase, fixerCase, summarizerCase,
];
