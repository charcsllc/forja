/**
 * The recorded catalog of `schema.ts` (see record-catalog.ts) turned into a structure,
 * for DB-free unit tests. `product.manual_file` is marked as sampled-multiple, which is
 * what `introspect` finds in the seeded data.
 */
import { readFileSync } from "node:fs";
import { buildStructure, type Catalog, type CmsStructure } from "../src/index.js";

export function loadCatalog(): Catalog {
  return JSON.parse(readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8")) as Catalog;
}

export function fixtureStructure(): CmsStructure {
  return buildStructure(loadCatalog(), { multipleFileColumns: ["product.manual_file"] });
}
