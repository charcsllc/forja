/**
 * Maintenance script: regenerates `test/fixtures/catalog.json` (the raw pg_catalog facts
 * of the fixture schema, read from a real throwaway Postgres 17) that the unit tests of
 * `buildStructure` use. Run: `npx tsx test/record-catalog.ts` (needs Docker).
 */
import { writeFileSync } from "node:fs";
import postgres from "postgres";
import { fetchCatalog } from "../src/introspect.js";
import { startPostgres } from "./pg.js";
import { SCHEMA_SQL, SEED_SQL } from "./schema.js";

const pg = await startPostgres();
const sql = postgres(pg.url, { max: 1, onnotice: () => {} });
try {
  await sql.unsafe(SCHEMA_SQL);
  await sql.unsafe(SEED_SQL);
  const catalog = await sql.begin((tx) => fetchCatalog(tx, "public"));
  writeFileSync(new URL("./fixtures/catalog.json", import.meta.url), `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`tables=${catalog.tables.length} columns=${catalog.columns.length} constraints=${catalog.constraints.length}`);
} finally {
  await sql.end({ timeout: 1 });
  pg.stop();
}
