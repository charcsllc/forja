import boundaries from "eslint-plugin-boundaries";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * Architecture rules (docs/adr/0001-stack.md):
 *   domain         → nothing outside its own module's domain (plus lib/result)
 *   application    → its module's application, any module's domain, lib
 *   infrastructure → its module's application + domain, other modules' public entry, db, lib, env, content
 *   ui / app       → application, a module's public entry (`@/modules/<m>`), components, lib, content
 *   modules/A      → never modules/B/infrastructure (go through B's public entry)
 */
// Order matters: the first matching descriptor classifies a file.
const elements = [
  { type: "domain", pattern: "src/modules/*/domain", capture: ["module"] },
  { type: "application", pattern: "src/modules/*/application", capture: ["module"] },
  { type: "infrastructure", pattern: "src/modules/*/infrastructure", capture: ["module"] },
  { type: "module-ui", pattern: "src/modules/*/ui", capture: ["module"] },
  // What is left directly in src/modules/<m>/ is the module's public entry (index.ts).
  { type: "module-api", pattern: "src/modules/*", capture: ["module"] },
  { type: "app", pattern: "src/app" },
  { type: "components", pattern: "src/components" },
  { type: "content", pattern: "src/content" },
  { type: "db", pattern: "src/db" },
  { type: "lib", pattern: "src/lib" },
  { type: "jobs", pattern: "src/jobs" },
  // src/env.ts, src/proxy.ts, src/instrumentation.ts. Only env.ts is ever imported.
  { type: "root", pattern: "src" },
];

const sameModule = { captured: { module: "{{ from.captured.module }}" } };
const el = (type, extra = {}) => ({ to: { element: { type, ...extra } } });

const policies = [
  { from: { element: { type: "domain" } }, allow: [el("domain", sameModule), el("lib")] },
  // Any module's domain may be shared (types such as SessionUser); never another module's application or infrastructure.
  { from: { element: { type: "application" } }, allow: [el("application", sameModule), el("domain"), el("lib")] },
  {
    from: { element: { type: "infrastructure" } },
    allow: [
      el("infrastructure", sameModule),
      el("application", sameModule),
      el("domain", sameModule),
      el("module-api"),
      el("db"),
      el("lib"),
      el("root"),
      el("content"),
    ],
  },
  {
    from: { element: { type: "module-ui" } },
    allow: [
      el("module-ui", sameModule),
      el("application", sameModule),
      el("domain", sameModule),
      el("module-api"),
      el("components"),
      el("lib"),
      el("content"),
    ],
  },
  {
    from: { element: { type: "module-api" } },
    allow: [
      el("infrastructure", sameModule),
      el("application", sameModule),
      el("domain", sameModule),
      el("module-ui", sameModule),
    ],
  },
  {
    from: { element: { type: "app" } },
    allow: [
      el("app"),
      el("application"),
      el("module-api"),
      el("module-ui"),
      el("components"),
      el("lib"),
      el("content"),
      el("db"),
      el("root"),
    ],
  },
  {
    from: { element: { type: "components" } },
    allow: [el("components"), el("module-api"), el("module-ui"), el("lib"), el("content")],
  },
  { from: { element: { type: "content" } }, allow: [el("content")] },
  { from: { element: { type: "db" } }, allow: [el("db"), el("lib"), el("root")] },
  { from: { element: { type: "lib" } }, allow: [el("lib"), el("db"), el("root")] },
  {
    from: { element: { type: "jobs" } },
    allow: [el("jobs"), el("module-api"), el("application"), el("lib"), el("db"), el("root")],
  },
  { from: { element: { type: "root" } }, allow: [el("jobs"), el("lib"), el("root")] },
];

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "dist/**",
      "drizzle/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  },
  ...nextVitals,
  ...nextTypescript,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { boundaries },
    settings: {
      "boundaries/elements": elements,
      "boundaries/include": ["src/**/*"],
      "import/resolver": { typescript: { alwaysTryTypes: true } },
    },
    rules: {
      "boundaries/dependencies": ["error", { default: "disallow", policies }],
      // Configuration is read in src/env.ts only.
      "no-restricted-properties": [
        "error",
        { object: "process", property: "env", message: "Read configuration from `@/env`." },
      ],
    },
  },
  {
    // The seed is a script: it may reach into a module's infrastructure (BetterAuth) to create users.
    files: ["src/db/seed.ts"],
    rules: { "boundaries/dependencies": "off" },
  },
  {
    files: ["src/env.ts", "src/instrumentation.ts"],
    rules: { "no-restricted-properties": "off" },
  },
  {
    files: ["scripts/**/*.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
    },
  },
];

export default config;
