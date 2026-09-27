/** imagery: every image in public/media must be registered with a licence in the manifest. */
import type { EvalCase } from "../types.js";
import { check, readText } from "./helpers.js";

export const imageryCase: EvalCase = {
  role: "imagery",
  id: "imagery-register-license",
  title: "Register the hero image in the media manifest",
  input: {
    task: "public/media/hero.webp was added from the local placeholder generator. Register it in public/media/manifest.json with slot, source, license and alt.",
    files: {
      "public/media/manifest.json": '{\n  "images": []\n}\n',
      "public/media/hero.webp": "placeholder-bytes",
    },
  },
  expect: {
    reportStatus: "done",
    filesChanged: ["public/media/manifest.json"],
    strictScope: true,
    customCheck: async (wd) => {
      try {
        const m = JSON.parse((await readText(wd, "public/media/manifest.json")) ?? "") as { images?: Array<Record<string, unknown>> };
        const hero = m.images?.find((i) => i.file === "hero.webp");
        return check(!!hero && typeof hero.license === "string" && typeof hero.alt === "string" && hero.alt.length > 0 && typeof hero.source === "string", `hero entry incomplete: ${JSON.stringify(hero)}`);
      } catch {
        return check(false, "manifest is not valid JSON");
      }
    },
  },
  golden: {
    files: {
      "public/media/manifest.json": '{\n  "images": [\n    { "file": "hero.webp", "slot": "home.hero", "source": "local-placeholder", "license": "CC0-1.0", "alt": "Fresh bread on a wooden counter" }\n  ]\n}\n',
    },
    report: { status: "done" },
  },
};
