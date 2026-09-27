import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    // Integration tests create one database per file; keep files isolated.
    isolate: true,
    fileParallelism: true,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      // Placeholders so src/env.ts validates in unit tests. The DB helper replaces DATABASE_URL.
      DATABASE_URL: "postgres://test:test@127.0.0.1:5432/unused",
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    },
  },
});
