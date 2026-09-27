/**
 * Bundles the engine into dist/ with esbuild.
 *
 * Why a bundle: the workspace packages (`@forja/contracts`, `@forja/git`, `@forja/sandbox`)
 * export TypeScript sources with extensionless imports, which plain `node` cannot load.
 * They are compiled INTO the bundle; every npm package stays external and is resolved from
 * node_modules at runtime (the Docker image installs them with `npm ci --omit=dev`).
 * Type checking is done separately by `tsc --noEmit` (see the `build` script).
 *
 * Entry points: `index.js` (the server) and `migrate.js` (standalone migrations).
 */
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Bare imports that are not workspace packages stay external. */
const externalNpm = {
  name: "external-npm",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@forja/")) return undefined;
      return { path: args.path, external: true };
    });
  },
};

await rm(`${root}dist`, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: { index: "src/index.ts", migrate: "src/migrate-cli.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  plugins: [externalNpm],
  logLevel: "warning",
});
console.log("engine bundled to dist/");
