/** database: add a Drizzle table in the schema file (write scope: src/db/**). */
import type { EvalCase } from "../types.js";

export const databaseCase: EvalCase = {
  role: "database",
  id: "database-bookings-table",
  title: "Add a bookings table to the Drizzle schema",
  input: {
    task: "Add a `bookings` table to src/db/schema.ts with id (uuid, primary key, default random), name (text, not null), date (timestamp, not null) and createdAt (timestamp, default now). Export it.",
    files: {
      "src/db/schema.ts": 'import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";\n\nexport const users = pgTable("users", {\n  id: uuid("id").primaryKey().defaultRandom(),\n  email: text("email").notNull().unique(),\n});\n',
    },
  },
  expect: {
    reportStatus: "done",
    filesChanged: ["src/db/schema.ts"],
    filesContain: [{ path: "src/db/schema.ts", includes: ['export const bookings = pgTable("bookings"', 'uuid("id").primaryKey().defaultRandom()', 'text("name").notNull()', 'timestamp("date").notNull()', "defaultNow()", "export const users"] }],
  },
  golden: {
    files: {
      "src/db/schema.ts":
        'import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";\n\nexport const users = pgTable("users", {\n  id: uuid("id").primaryKey().defaultRandom(),\n  email: text("email").notNull().unique(),\n});\n\nexport const bookings = pgTable("bookings", {\n  id: uuid("id").primaryKey().defaultRandom(),\n  name: text("name").notNull(),\n  date: timestamp("date").notNull(),\n  createdAt: timestamp("created_at").defaultNow(),\n});\n',
    },
    report: { status: "done" },
  },
};
