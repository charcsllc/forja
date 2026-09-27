/**
 * Compiler rules (05 §6.3) checked on the SQL text and parameters, without a database.
 * Snapshots pin the exact statement of each operator; the explicit assertions state the
 * rule each snapshot protects (fallbacks, FALSE on unparseable values, escaping, caps,
 * and that no value ever lands in the SQL text).
 */
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { CmsError, compileQuery, isCmsError, type CmsStructure } from "../src/index.js";
import { fixtureStructure } from "./fixture.js";
import { render } from "./render.js";

// Never connects: fragments are only rendered, never awaited.
const sql = postgres({ host: "127.0.0.1", port: 1, max: 1 });
afterAll(() => sql.end({ timeout: 0 }));

const structure = fixtureStructure();

function compile(table: string, options: unknown, s: CmsStructure = structure) {
  const { query, plan } = compileQuery(sql, s, table, options);
  return { ...render(query), plan };
}

/** The WHERE clause of the main query alone, its parameters renumbered from $1. */
function where(table: string, filter: unknown) {
  const { text, params } = compile(table, { _filter: filter });
  const main = text.search(/ AS r(, count\(\*\) OVER \(\) AS c)? FROM /);
  const start = text.indexOf(" WHERE ", main) + 7;
  const end = text.lastIndexOf(" ORDER BY ");
  const used: unknown[] = [];
  const clause = text.slice(start, end).replace(/\$(\d+)/g, (_match, n: string) => {
    used.push(params[Number(n) - 1]);
    return `$${used.length}`;
  });
  return { sql: clause, params: used };
}

function thrown(fn: () => unknown): CmsError {
  try {
    fn();
  } catch (error) {
    if (isCmsError(error)) return error;
    throw error;
  }
  throw new Error("expected a CmsError");
}

describe("compileQuery: the page query", () => {
  it("builds the grid query the UI sends (paging, sort, count, expansions)", () => {
    const out = compile("order", {
      _limit: 25,
      _offset: 50,
      _sort: { createdAt: "desc" },
      _count: true,
      customerId: true,
      product: { _limit: 5 },
    });
    expect(out.text).toMatchSnapshot();
    expect(out.params).toEqual(["5", "25", "50"]);
    expect(out.plan).toMatchObject({ table: "order", count: true, limit: 25, offset: 50 });
    expect(out.plan.sort).toEqual([
      { property: "createdAt", direction: "desc" },
      { property: "_id", direction: "desc" },
    ]);
    expect(out.plan.expansions.map((e) => [e.key, e.relation.kind, e.limit])).toEqual([
      ["customerId", "manyToOne", 300],
      ["product", "manyToMany", 5],
    ]);
  });

  it("includes many-to-many ids when not expanded, and count only when asked", () => {
    const out = compile("product", { _limit: 1 });
    expect(out.text).toContain(`AS "order"`);
    expect(out.text).toContain(`json_agg("t`);
    expect(out.text).not.toContain("count(*) OVER ()");
    expect(compile("product", { _limit: 1, _count: true }).text).toContain("count(*) OVER () AS c");
  });

  it("caps _limit at 1000 and expansion limits at 300; defaults to 100", () => {
    expect(compile("customer", { _limit: 5000 }).plan.limit).toBe(1000);
    expect(compile("customer", {}).plan.limit).toBe(100);
    expect(compile("customer", { order: { _limit: 900 } }).plan.expansions[0]?.limit).toBe(300);
  });

  it("ignores unknown or non-relation expansion keys, and resolves a table name to its only relation", () => {
    const out = compile("customer", { nope: true, name: true, order: true });
    expect(out.plan.expansions.map((e) => e.key)).toEqual(["order"]);
    const byTable = compile("order", { customer: true });
    expect(byTable.plan.expansions.map((e) => [e.key, e.relation.name])).toEqual([["customer", "customerId"]]);
    expect(byTable.text).toContain(`AS "customer"`);
  });
});

describe("_sort", () => {
  it("sorts by a known property, then the primary key", () => {
    expect(compile("customer", { _sort: { name: "asc" } }).plan.sort).toEqual([
      { property: "name", direction: "asc" },
      { property: "_id", direction: "asc" },
    ]);
    expect(compile("customer", { _sort: { name: "asc" } }).text).toContain(`ORDER BY "t0"."name" ASC NULLS LAST, "t0"."id" ASC NULLS LAST`);
  });

  it("falls back to created_at for an unknown or relation key, never failing", () => {
    for (const key of ["nope", "order", "createdBy"]) {
      expect(compile("customer", { _sort: { [key]: "desc" } }).plan.sort[0]).toEqual({ property: "createdAt", direction: "desc" });
    }
  });

  it("falls back to the primary key when there is no created_at", () => {
    const s = fixtureStructure();
    const customer = s.model.tables.customer;
    if (!customer) throw new Error("fixture");
    delete customer.createdAt;
    expect(compile("customer", { _sort: { nope: "desc" } }, s).plan.sort).toEqual([{ property: "_id", direction: "desc" }]);
    expect(compile("customer", {}, s).plan.sort).toEqual([{ property: "_id", direction: "asc" }]);
  });

  it("sorts json columns as text", () => {
    expect(compile("customer", { _sort: { preferences: "asc" } }).text).toContain(`"t0"."preferences"::text ASC`);
  });
});

describe("_filter operators", () => {
  const cases: [string, string, unknown][] = [
    ["eq text", "customer", { name: "Customer 001" }],
    ["eq null", "customer", { email: null }],
    ["eq number", "customer", { visits: 3 }],
    ["eq numeric string", "customer", { creditLimit: "10.5" }],
    ["eq boolean", "customer", { vip: true }],
    ["eq enum", "order", { status: "paid" }],
    ["eq enum array", "order", { history: "shipped" }],
    ["eq date", "customer", { birthDate: "1990-01-05" }],
    ["eq timestamp day", "customer", { lastSeenAt: "2026-06-01T00:00:00.000Z" }],
    ["eq timestamp exact", "customer", { lastSeenAt: "2026-06-01T14:00:00.000Z" }],
    ["eq fk", "order", { customerId: "cus_001" }],
    ["eq _id", "order", { _id: "ord_01" }],
    ["ne", "customer", { email: { ne: "c1@example.com" } }],
    ["ne null", "customer", { email: { ne: null } }],
    ["gt gte lt lte number", "customer", { visits: { gt: 1, lte: 3 }, creditLimit: { gte: "20", lt: 100 } }],
    ["gt date", "customer", { createdAt: { gt: "2026-01-02T00:00:00.000Z" } }],
    ["gt text", "customer", { name: { gt: "Customer 100" } }],
    ["contains", "customer", { name: { contains: "50%_off\\" } }],
    ["startsWith", "customer", { name: { startsWith: "Cust" } }],
    ["endsWith", "customer", { name: { endsWith: "_1" } }],
    ["regex i", "customer", { name: { regex: "customer 00[1-3]", options: "i" } }],
    ["regex", "customer", { name: { regex: "^C" } }],
    ["in text", "customer", { name: { in: ["a", "b"] } }],
    ["in enum", "order", { status: { in: ["paid", "shipped"] } }],
    ["in number", "customer", { visits: { in: [1, "2", "x"] } }],
    ["in _id", "order", { _id: { in: ["ord_01", "ord_02"] } }],
    ["isEmpty text", "customer", { email: { in: [null, ""] } }],
    ["isNotEmpty text", "customer", { email: { nin: [null, ""] } }],
    ["isEmpty number", "customer", { creditLimit: { in: [null, ""] } }],
    ["isNotEmpty number", "customer", { creditLimit: { nin: [null, ""] } }],
    ["isEmpty file", "customer", { avatarImage: { in: [null, ""] } }],
    ["isNotEmpty file", "customer", { documentsFile: { nin: [null, ""] } }],
    ["isEmpty array", "customer", { tags: { in: [null, ""] } }],
    ["in enum array", "order", { history: { in: ["paid"] } }],
    ["nin enum", "order", { status: { nin: ["cancelled"] } }],
    ["_or search", "customer", { _or: [{ name: { regex: "abc", options: "i" } }, { email: { regex: "abc", options: "i" } }] }],
    ["_has manyToOne", "order", { customerId: { _has: "some", _filter: { vip: true } } }],
    ["_has oneToMany", "customer", { order: { _has: "some", _filter: { status: "paid", total: { gt: 10 } } } }],
    ["_has manyToMany", "product", { order: { _has: "some", _filter: { status: "paid" } } }],
    ["_has nested _or", "customer", { order: { _has: "some", _filter: { _or: [{ status: "paid" }, { status: "shipped" }] } } }],
    ["to-many eq id", "product", { order: "ord_01" }],
    ["to-many in / empty", "customer", { order: { in: ["ord_01", null] } }],
    ["to-many nin", "product", { order: { nin: ["ord_01"] } }],
    ["to-many ne", "customer", { order: { ne: "ord_01" } }],
    ["to-many isNotEmpty", "customer", { order: { nin: [null, ""] } }],
  ];

  it.each(cases)("%s", (_name, table, filter) => {
    expect(where(table, filter)).toMatchSnapshot();
  });

  it("never puts a value in the SQL text", () => {
    for (const [, table, filter] of cases) {
      const { sql: text, params } = where(table, filter);
      for (const param of params) {
        if (typeof param === "string" && param.length > 2) expect(text).not.toContain(param);
      }
    }
  });

  it("escapes ILIKE wildcards and backslashes", () => {
    expect(where("customer", { name: { contains: "50%_off\\" } }).params).toEqual(["%50\\%\\_off\\\\%"]);
    expect(where("customer", { name: { startsWith: "a_b" } }).params).toEqual(["a\\_b%"]);
    expect(where("customer", { name: { endsWith: "%" } }).params).toEqual(["%\\%"]);
  });

  it("compiles unparseable values to FALSE instead of failing", () => {
    expect(where("customer", { visits: "abc" }).sql).toBe("FALSE");
    expect(where("customer", { visits: { gt: "1e999" } }).sql).toBe("FALSE");
    expect(where("customer", { birthDate: "not a date" }).sql).toBe("FALSE");
    expect(where("customer", { vip: "maybe" }).sql).toBe("FALSE");
    expect(where("customer", { vip: { gt: 1 } }).sql).toBe("FALSE");
    expect(where("customer", { visits: { in: ["x", "y"] } }).sql).toBe("FALSE");
    expect(where("customer", { visits: { ne: "abc" } }).sql).toBe("NOT COALESCE(FALSE, FALSE)");
  });

  it("empty-value filters on non-text columns are IS NULL / IS NOT NULL", () => {
    expect(where("customer", { creditLimit: { in: [null, ""] } }).sql).toBe(`"t0"."credit_limit" IS NULL`);
    expect(where("customer", { creditLimit: { nin: [null, ""] } }).sql).toBe(`NOT COALESCE("t0"."credit_limit" IS NULL, FALSE)`);
  });
});

describe("refusals", () => {
  it("unknown table → TABLE_NOT_FOUND (bridges and excluded tables too)", () => {
    for (const name of ["nope", "session", "order_product", "constructor", "__proto__"]) {
      expect(thrown(() => compile(name, {})).code).toBe("TABLE_NOT_FOUND");
    }
  });

  it("unknown filter field → PROPERTY_NOT_FOUND", () => {
    expect(thrown(() => compile("customer", { _filter: { nope: 1 } })).code).toBe("PROPERTY_NOT_FOUND");
    expect(thrown(() => compile("customer", { _filter: { order: { _has: "some", _filter: { nope: 1 } } } })).code).toBe("PROPERTY_NOT_FOUND");
  });

  it("malformed options → VALIDATION", () => {
    expect(thrown(() => compile("customer", { _limit: -1 })).code).toBe("VALIDATION");
    expect(thrown(() => compile("customer", { _filter: { name: { like: "x" } } })).code).toBe("VALIDATION");
    expect(thrown(() => compile("customer", { _filter: { name: { _has: "some", _filter: {} } } })).code).toBe("VALIDATION");
    expect(thrown(() => compile("customer", { _sort: { name: "up" } })).code).toBe("VALIDATION");
    expect(thrown(() => compile("customer", { order: 5 })).code).toBe("VALIDATION");
    let deep: Record<string, unknown> = { name: "x" };
    for (let i = 0; i < 12; i++) deep = { _or: [deep] };
    expect(thrown(() => compile("customer", { _filter: deep })).code).toBe("VALIDATION");
  });
});
