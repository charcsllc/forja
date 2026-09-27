import { defineConfig } from "drizzle-kit";

// drizzle-kit only needs a URL for `push`/`studio`/`introspect`; `generate` works offline.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle/migrations",
  schemaFilter: ["public", "internal"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost:5432/app" },
  strict: true,
  verbose: true,
});
