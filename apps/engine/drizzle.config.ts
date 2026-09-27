import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` needs no database; DATABASE_URL only matters for `studio`/`push`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://forja:forja@localhost:5432/forja",
  },
  strict: true,
  verbose: true,
});
