/**
 * `image_find`: one image per slot, through the injected `ImageSourcingPort`
 * (`@forja/contracts/media`, implemented by `packages/media`).
 *
 * What this protects: the model never chooses between searching and generating (the
 * instance setting does) and never downloads anything itself; it names a slot and gets a
 * file inside the project plus the attribution the app must show. Without a port the tool
 * answers a clear error instead of failing the task.
 */
import { ImageFindRequestSchema } from "@forja/contracts/media";
import { WorkspaceError, defineTool, fail, ok } from "./types.js";

export const imageFindTool = defineTool({
  name: "image_find",
  kind: "media",
  description: [
    "Get one image for one image slot of the app. Call it ONCE per slot (hero, team-1, product-candle…), never twice for the same slot.",
    "slot becomes the file name; query is an English description of the subject; alt is the alt text in the app's language.",
    "The file is written into the project for you: use the returned publicUrl (e.g. /images/hero.jpg) with next/image and the returned width and height.",
    "When the result has attribution.attributionRequired = true you MUST show the credit (author, license and a link to pageUrl) in the app,",
    "for example on a /credits page that reads public/images/credits.json, linked from the footer.",
  ].join(" "),
  input: ImageFindRequestSchema,
  summarize: (a) => `${a.slot}: ${a.query.slice(0, 80)}`,
  async execute(args, ctx) {
    if (!ctx.imageSourcing) {
      return fail("UNAVAILABLE: image sourcing is not configured on this engine. Use a neutral placeholder (a CSS gradient or an inline SVG) and list the missing image in your report's concerns.");
    }
    try {
      const result = await ctx.imageSourcing.find(args, {
        projectId: ctx.projectId,
        runId: ctx.runId,
        abortSignal: ctx.abortSignal,
        // Lets the port merge `public/images/credits.json` with earlier runs; null = absent.
        readFile: async (path) => {
          try {
            return await ctx.workspace.readFile(path);
          } catch (err) {
            if (err instanceof WorkspaceError && err.code === "NOT_FOUND") return null;
            throw err;
          }
        },
        writeFile: async (path, data) => {
          const { created } = await ctx.workspace.writeFile(path, data);
          ctx.emit({ type: "file.written", path, bytes: data.byteLength, created });
        },
      });
      return ok(JSON.stringify(result, null, 2), `${args.slot} → ${result.publicUrl} (${result.attribution.provider}, ${result.attribution.license})`);
    } catch (err) {
      return fail(`IMAGE_NOT_FOUND: ${err instanceof Error ? err.message : String(err)}. Use a neutral placeholder and mention it in your report's concerns.`);
    }
  },
});
