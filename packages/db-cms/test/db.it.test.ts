/**
 * Integration suite against a real, throwaway Postgres 17 (run with FORJA_DB_IT=1).
 *
 * Starts `postgres:17-alpine` on tmpfs and a random loopback port, loads `schema.ts`,
 * creates the `cms_ro` / `cms_rw` roles the sandbox provisions, and drives every query
 * shape the database tab sends (docs/research/02 §6): paging 25/50/100 with `_count`,
 * sort, the search `_or` of regexes, each filter operator, relation `_has`, per-table
 * counts, expansions both ways, a single record by `_id`, CRUD, link/unlink by property
 * NAME, and the timeout. The container is removed afterwards.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DbQueryResultSchema, TablesStructureResultSchema, type DbRow } from "@forja/contracts/v1";
import {
  createRecord,
  deleteRecord,
  executeQuery,
  introspect,
  isCmsError,
  link,
  unlink,
  updateRecord,
  withCmsTransaction,
  type CmsStructure,
} from "../src/index.js";
import { fixtureStructure } from "./fixture.js";
import { startPostgres, type ThrowawayPg } from "./pg.js";
import { SCHEMA_SQL, SEED_SQL } from "./schema.js";

const RUN = process.env.FORJA_DB_IT === "1";
const files = { resolveFileUrl: (name: string) => `https://files.test/${name}` };

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isCmsError(error)) return error.code;
    throw error;
  }
  return "OK";
}

describe.skipIf(!RUN)("db-cms against real Postgres", { timeout: 120_000 }, () => {
  let pg: ThrowawayPg | undefined;
  let admin: postgres.Sql;
  let ro: postgres.Sql;
  let rw: postgres.Sql;
  let structure: CmsStructure;

  const query = async (table: string, options: Record<string, unknown>): Promise<DbRow[]> => {
    const result = await executeQuery(ro, structure, table, options, files);
    expect(DbQueryResultSchema.safeParse(result).success).toBe(true);
    return result.results;
  };
  const total = async (table: string, filter?: Record<string, unknown>): Promise<number> => {
    const rows = await query(table, { ...(filter ? { _filter: filter } : {}), _limit: 1, _count: true });
    return rows[0]?._count?._total ?? 0;
  };
  const ids = (rows: DbRow[]) => rows.map((row) => row._id);

  beforeAll(async () => {
    pg = await startPostgres();
    admin = postgres(pg.url, { max: 1, onnotice: () => {} });
    await admin.unsafe(SCHEMA_SQL);
    await admin.unsafe(SEED_SQL);
    await admin.unsafe(`
      CREATE ROLE cms_ro LOGIN PASSWORD 'ro';
      CREATE ROLE cms_rw LOGIN PASSWORD 'rw';
      GRANT USAGE ON SCHEMA public TO cms_ro, cms_rw;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO cms_ro;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cms_rw;`);
    const url = new URL(pg.url);
    const as = (user: string, password: string) => {
      const u = new URL(url);
      u.username = user;
      u.password = password;
      return postgres(u.toString(), { max: 2, onnotice: () => {} });
    };
    ro = as("cms_ro", "ro");
    rw = as("cms_rw", "rw");
    structure = await introspect(ro);
  });

  afterAll(async () => {
    await Promise.all([admin?.end({ timeout: 1 }), ro?.end({ timeout: 1 }), rw?.end({ timeout: 1 })]);
    pg?.stop();
  });

  describe("introspect", () => {
    it("exposes the business tables and `user` only, as a valid v1 structure", () => {
      expect(TablesStructureResultSchema.safeParse({ tables: structure.tables }).success).toBe(true);
      expect(structure.tables.map((t) => t.type)).toEqual(["category", "customer", "empty_thing", "order", "product", "user"]);
    });

    it("matches the pure build over the recorded catalog (sampling found product.manual_file)", () => {
      expect(structure.tables).toEqual(fixtureStructure().tables);
      expect(structure.tables.find((t) => t.type === "product")?.properties.manualFile?.typeExtras).toEqual({ file: { multiple: true } });
    });
  });

  describe("grid queries", () => {
    it.each([25, 50, 100])("pages of %i with _count", async (size) => {
      const first = await query("customer", { _limit: size, _offset: 0, _sort: { createdAt: "desc" }, _count: true });
      expect(first).toHaveLength(size);
      expect(first[0]?._count).toEqual({ _total: 122 });
      expect(first[0]?._id).toBe("cus_120");
      expect(first.slice(1).every((row) => row._count === undefined)).toBe(true);
      const lastOffset = Math.floor(121 / size) * size;
      const last = await query("customer", { _limit: size, _offset: lastOffset, _sort: { createdAt: "desc" }, _count: true });
      expect(last).toHaveLength(122 - lastOffset);
      expect(last.at(-1)?._id).toBe("cus_x01");
      const second = await query("customer", { _limit: size, _offset: size, _sort: { createdAt: "desc" } });
      expect(ids(second).some((id) => ids(first).includes(id))).toBe(false);
    });

    it("an offset past the end returns no rows (and so no count)", async () => {
      expect(await query("customer", { _limit: 25, _offset: 500, _count: true })).toEqual([]);
    });

    it("sorts by a column and falls back to createdAt for an unknown one", async () => {
      const byName = await query("customer", { _limit: 3, _sort: { name: "asc" } });
      // The first two differ only in punctuation, whose order depends on the collation.
      expect(byName.slice(0, 2).map((r) => r.name).sort()).toEqual(["50%_off \\ deal", "5000 off deal"]);
      expect(byName[2]?.name).toBe("Customer 001");
      const unknown = await query("customer", { _limit: 5, _sort: { nope: "asc" } });
      const created = await query("customer", { _limit: 5, _sort: { createdAt: "asc" } });
      expect(ids(unknown)).toEqual(ids(created));
      expect(ids(created)[0]).toBe("cus_x01");
    });

    it("search: an _or of case-insensitive regexes over the text fields", async () => {
      const textFields = Object.values(structure.tables.find((t) => t.type === "customer")?.properties ?? {})
        .filter((p) => p.propertyType === "string" || p.propertyType === "long-string")
        .map((p) => p.name);
      const search = (term: string) => ({
        _or: textFields.map((name) => ({ [name]: { regex: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), options: "i" } })),
      });
      expect(ids(await query("customer", { _filter: search("CUSTOMER 050"), _limit: 25 }))).toEqual(["cus_050"]);
      expect(ids(await query("customer", { _filter: search("50%_off \\"), _limit: 25 }))).toEqual(["cus_x01"]);
      expect(await total("customer", search("weird"))).toBe(1);
      expect(await total("customer", search("("))).toBe(0);
    });
  });

  describe("filters", () => {
    it.each<[string, string, Record<string, unknown>, number]>([
      ["boolean eq", "customer", { vip: true }, 12],
      ["ne null", "customer", { email: { ne: null } }, 82],
      ["isEmpty text", "customer", { email: { in: [null, ""] } }, 41],
      ["isNotEmpty text", "customer", { email: { nin: [null, ""] } }, 81],
      ["ne value keeps NULLs", "customer", { email: { ne: "c1@example.com" } }, 121],
      ["integer range", "customer", { visits: { gt: 1, lte: 3 } }, 48],
      ["numeric range", "customer", { creditLimit: { gte: 100, lt: "200" } }, 9],
      ["isEmpty numeric", "customer", { creditLimit: { in: [null, ""] } }, 19],
      ["date eq", "customer", { birthDate: "1990-01-05" }, 1],
      ["timestamp day eq", "customer", { lastSeenAt: "2026-06-02T00:00:00.000Z" }, 12],
      ["timestamp gt", "customer", { createdAt: { gt: "2026-01-05T00:00:00.000Z" } }, 24],
      ["contains escapes % and _", "customer", { name: { contains: "50%_off" } }, 1],
      ["contains backslash", "customer", { name: { contains: "\\" } }, 1],
      ["startsWith is case-insensitive", "customer", { name: { startsWith: "customer 11" } }, 10],
      ["endsWith", "customer", { name: { endsWith: "DEAL" } }, 2],
      ["regex", "customer", { name: { regex: "^customer 0[0-4]", options: "i" } }, 49],
      ["regex case-sensitive", "customer", { name: { regex: "^customer" } }, 0],
      ["enum in", "order", { status: { in: ["paid", "shipped"] } }, 30],
      ["enum nin", "order", { status: { nin: ["cancelled"] } }, 45],
      ["enum array eq", "order", { history: "shipped" }, 15],
      ["enum array in", "order", { history: { in: ["paid"] } }, 15],
      ["enum array isEmpty", "order", { history: { in: [null, ""] } }, 45],
      ["text array isEmpty", "customer", { tags: { in: [null, ""] } }, 102],
      ["file isNotEmpty", "customer", { avatarImage: { nin: [null, ""] } }, 30],
      ["file array '[]' is empty", "customer", { documentsFile: { in: [null, ""] } }, 122],
      ["unparseable number → no rows", "customer", { visits: "abc" }, 0],
      ["unparseable date → no rows", "order", { placedAt: { gt: "someday" } }, 0],
      ["fk eq", "order", { customerId: "cus_001" }, 2],
      ["fk isEmpty", "order", { customerId: { in: [null, ""] } }, 1],
      ["_id in", "order", { _id: { in: ["ord_01", "ord_02", "nope"] } }, 2],
      ["relation _has manyToOne", "order", { customerId: { _has: "some", _filter: { vip: true } } }, 6],
      ["relation _has oneToMany", "customer", { order: { _has: "some", _filter: { status: "paid" } } }, 5],
      ["relation _has manyToMany", "product", { order: { _has: "some", _filter: { number: { lte: 3 } } } }, 6],
      ["to-many by id (RecordDetail)", "product", { order: "ord_01" }, 2],
      ["to-many isNotEmpty", "customer", { order: { nin: [null, ""] } }, 20],
      ["to-many isEmpty", "customer", { order: { in: [null, ""] } }, 102],
      ["join filter + search", "customer", { order: { _has: "some", _filter: { status: "paid" } }, _or: [{ name: { regex: "0?2$", options: "i" } }] }, 1],
    ])("%s", async (_name, table, filter, expected) => {
      expect(await total(table, filter)).toBe(expected);
    });

    it("an invalid regex is a VALIDATION error, not a crash", async () => {
      expect(await code(executeQuery(ro, structure, "customer", { _filter: { name: { regex: "(", options: "i" } } }))).toBe("VALIDATION");
    });
  });

  describe("counts, single records and expansions", () => {
    it("per-table count with {_limit:1,_count:true}; an empty table returns no rows", async () => {
      expect(await total("customer")).toBe(122);
      expect(await total("order")).toBe(60);
      expect(await total("product")).toBe(10);
      expect(await total("user")).toBe(1);
      expect(await total("category")).toBe(2);
      expect(await query("empty_thing", { _limit: 1, _count: true })).toEqual([]);
    });

    it("a single record by _id, with file urls from the resolver", async () => {
      const [row] = await query("customer", { _filter: { _id: "cus_004" }, _limit: 1 });
      expect(row).toMatchObject({
        _id: "cus_004",
        name: "Customer 004",
        visits: 4,
        creditLimit: 42,
        birthDate: "1990-01-05",
        lastSeenAt: "2026-06-01T16:00:00.000Z",
        createdAt: "2026-01-01T04:00:00.000Z",
        avatarImage: { name: "avatar-4.png", url: "https://files.test/avatar-4.png", type: "image" },
        documentsFile: [],
        ownerId: "usr_1",
        vip: false,
        tags: null,
      });
      expect(row).not.toHaveProperty("order");
    });

    it("expands to-one and to-many relations (the grid's buildLinkExpansion shape)", async () => {
      const rows = await query("order", { _filter: { _id: { in: ["ord_01", "ord_60"] } }, _sort: { number: "asc" }, customerId: true, product: { _limit: 5 } });
      expect(rows[0]?.customerId).toMatchObject({ _id: "cus_002", name: "Customer 002", createdAt: "2026-01-01T02:00:00.000Z" });
      expect(ids(rows[0]?.product as DbRow[]).sort()).toEqual(["prd_02", "prd_05"]);
      expect((rows[0]?.product as DbRow[])[0]).toHaveProperty("price");
      expect(rows[1]?.customerId).toBeNull();

      const [customer] = await query("customer", { _filter: { _id: "cus_001" }, order: { _limit: 1 } });
      expect(ids(customer?.order as DbRow[])).toEqual(["ord_40"]);

      const [user] = await query("user", { _filter: { _id: "usr_1" }, customer: { _limit: 1000 } });
      expect((user?.customer as DbRow[]).length).toBe(60);
    });

    it("returns many-to-many ids when not expanded, ignores unknown expansions, and accepts a table name as key", async () => {
      const [product] = await query("product", { _filter: { _id: "prd_02" }, nope: true, name: true });
      expect((product?.order as string[]).length).toBeGreaterThan(0);
      expect(typeof (product?.order as string[])[0]).toBe("string");
      const [order] = await query("order", { _filter: { _id: "ord_01" }, customer: true });
      expect(order?.customer).toMatchObject({ _id: "cus_002" });
      expect(order?.customerId).toBe("cus_002");
    });
  });

  describe("records", () => {
    it("create → update → delete, with coercion and {name}-only files", async () => {
      const created = await createRecord(
        rw,
        structure,
        "customer",
        {
          name: "New person",
          vip: true,
          visits: "7",
          creditLimit: 12.5,
          birthDate: "2000-01-02",
          avatarImage: { name: "new.png", url: "https://stale.example/new.png" },
          documentsFile: [{ name: "doc.pdf" }],
          ownerId: "usr_1",
          tags: ["x", "y"],
          preferences: { theme: "dark" },
          order: ["ignored"],
        },
        files,
      );
      expect(created._id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
      expect(created).toMatchObject({
        name: "New person",
        vip: true,
        visits: 7,
        creditLimit: 12.5,
        birthDate: "2000-01-02",
        avatarImage: { name: "new.png", url: "https://files.test/new.png", type: "image" },
        documentsFile: [{ name: "doc.pdf", url: "https://files.test/doc.pdf" }],
        ownerId: "usr_1",
        tags: ["x", "y"],
        preferences: { theme: "dark" },
      });
      const [stored] = await admin`SELECT avatar_image, documents_file FROM customer WHERE id = ${created._id}`;
      expect(stored).toEqual({ avatar_image: { name: "new.png" }, documents_file: [{ name: "doc.pdf" }] });

      const updated = await updateRecord(rw, structure, "customer", created._id, { name: "Renamed", vip: "false", creditLimit: "99.99", email: "" }, files);
      expect(updated).toMatchObject({ _id: created._id, name: "Renamed", vip: false, creditLimit: 99.99, email: "" });
      expect(Date.parse(updated.updatedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(created.updatedAt ?? ""));

      expect(await deleteRecord(rw, structure, "customer", created._id)).toEqual({ _id: created._id });
      expect(await code(deleteRecord(rw, structure, "customer", created._id))).toBe("RECORD_NOT_FOUND");
    });

    it("creates an order with an enum, an enum array and a link", async () => {
      const order = await createRecord(rw, structure, "order", { number: 999, status: "paid", history: ["pending", "paid"], customerId: { _id: "cus_003" }, placedAt: "2026-09-27T10:00:00.000Z" });
      expect(order).toMatchObject({ number: 999, status: "paid", history: ["pending", "paid"], customerId: "cus_003", placedAt: "2026-09-27T10:00:00.000Z", product: [] });
      await deleteRecord(rw, structure, "order", order._id);
    });

    it("refuses bad writes with typed errors", async () => {
      expect(await code(updateRecord(rw, structure, "order", "ord_01", { status: "lost" }))).toBe("VALIDATION");
      expect(await code(updateRecord(rw, structure, "order", "ord_01", { nope: 1 }))).toBe("PROPERTY_NOT_FOUND");
      expect(await code(updateRecord(rw, structure, "order", "nope", { note: "x" }))).toBe("RECORD_NOT_FOUND");
      expect(await code(updateRecord(rw, structure, "product", "prd_02", { sku: "SKU-1" }))).toBe("VALIDATION");
      expect(await code(updateRecord(rw, structure, "customer", "cus_001", { name: null }))).toBe("VALIDATION");
      expect(await code(updateRecord(rw, structure, "order", "ord_01", { customerId: "cus_nope" }))).toBe("VALIDATION");
      expect(await code(createRecord(rw, structure, "session", { token: "x" }))).toBe("TABLE_NOT_FOUND");
      expect(await code(createRecord(rw, structure, "order_product", {}))).toBe("TABLE_NOT_FOUND");
      expect(await code(deleteRecord(rw, structure, "customer", "cus_nope"))).toBe("RECORD_NOT_FOUND");
    });

    it("never writes through the read-only path", async () => {
      await expect(withCmsTransaction(rw, { readOnly: true }, async (tx) => tx`DELETE FROM customer`)).rejects.toThrow(/read-only/);
      expect(await total("customer")).toBe(122);
    });
  });

  describe("link / unlink by property NAME", () => {
    it("many-to-many from either side, idempotent", async () => {
      const productIds = async () => (((await query("order", { _filter: { _id: "ord_01" } }))[0]?.product ?? []) as string[]).sort();
      expect(await productIds()).toEqual(["prd_02", "prd_05"]);

      expect((await link(rw, structure, "order", "ord_01", "product", "prd_09")).changed).toBe(true);
      expect((await link(rw, structure, "order", "ord_01", "product", "prd_09")).changed).toBe(false);
      expect(await productIds()).toEqual(["prd_02", "prd_05", "prd_09"]);
      expect(ids(await query("order", { _filter: { product: "prd_09" }, _limit: 100 }))).toContain("ord_01");

      expect((await unlink(rw, structure, "order", "ord_01", "product", "prd_09")).changed).toBe(true);
      expect((await unlink(rw, structure, "order", "ord_01", "product", "prd_09")).changed).toBe(false);
      expect(await productIds()).toEqual(["prd_02", "prd_05"]);

      expect((await link(rw, structure, "product", "prd_09", "order", "ord_01")).changed).toBe(true);
      expect(await productIds()).toEqual(["prd_02", "prd_05", "prd_09"]);
      const propertyId = structure.tables.find((t) => t.type === "product")?.properties.order?.id ?? "";
      expect((await unlink(rw, structure, "product", "prd_09", propertyId, "ord_01")).changed).toBe(true);
      expect(await productIds()).toEqual(["prd_02", "prd_05"]);
    });

    it("one-to-many and many-to-one links write the FK", async () => {
      await link(rw, structure, "customer", "cus_120", "order", "ord_60");
      expect((await query("order", { _filter: { _id: "ord_60" } }))[0]?.customerId).toBe("cus_120");
      await unlink(rw, structure, "customer", "cus_120", "order", "ord_60");
      expect((await query("order", { _filter: { _id: "ord_60" } }))[0]?.customerId).toBeNull();
      await link(rw, structure, "order", "ord_60", "customerId", "cus_005");
      expect((await query("order", { _filter: { _id: "ord_60" } }))[0]?.customerId).toBe("cus_005");
      await unlink(rw, structure, "order", "ord_60", "customerId", "cus_005");
      expect((await query("order", { _filter: { _id: "ord_60" } }))[0]?.customerId).toBeNull();
    });

    it("refuses unknown records and properties", async () => {
      expect(await code(link(rw, structure, "order", "ord_01", "product", "prd_nope"))).toBe("RECORD_NOT_FOUND");
      expect(await code(link(rw, structure, "order", "ord_nope", "product", "prd_01"))).toBe("RECORD_NOT_FOUND");
      expect(await code(link(rw, structure, "order", "ord_01", "nope", "prd_01"))).toBe("PROPERTY_NOT_FOUND");
      expect(await code(link(rw, structure, "order", "ord_01", "note", "prd_01"))).toBe("VALIDATION");
    });
  });

  describe("timeouts", () => {
    it("every call runs with statement_timeout = 10s", async () => {
      const [row] = await withCmsTransaction(ro, { readOnly: true }, async (tx) => tx`SHOW statement_timeout`);
      expect(row?.statement_timeout).toBe("10s");
      const [after] = await ro`SHOW statement_timeout`;
      expect(after?.statement_timeout).toBe("0");
    });

    it("a statement over the limit is QUERY_TIMEOUT", async () => {
      expect(await code(withCmsTransaction(ro, { readOnly: true, timeoutMs: 50 }, async (tx) => tx`SELECT pg_sleep(2)`))).toBe("QUERY_TIMEOUT");
    });
  });
});
