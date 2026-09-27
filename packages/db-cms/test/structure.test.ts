/**
 * Introspection rules (05 §6.2) over the recorded catalog of the fixture schema:
 * exclusions, bridges, shared relation ids, type mapping, file multiplicity, labels.
 */
import { describe, expect, it } from "vitest";
import { TablesStructureResultSchema } from "@forja/contracts/v1";
import { buildStructure, camelCase, humanize, stableId, tablesStructureResult } from "../src/index.js";
import { staticFileMultiple } from "../src/introspect.js";
import { fixtureStructure, loadCatalog } from "./fixture.js";

const structure = fixtureStructure();
const table = (name: string) => {
  const found = structure.tables.find((t) => t.type === name);
  if (!found) throw new Error(`no table ${name}`);
  return found;
};
const prop = (tableName: string, name: string) => {
  const found = table(tableName).properties[name];
  if (!found) throw new Error(`no property ${tableName}.${name}`);
  return found;
};

describe("buildStructure", () => {
  it("lists business tables and `user`, never BetterAuth internals, bridges or keyless tables", () => {
    expect(structure.tables.map((t) => t.type)).toEqual(["category", "customer", "empty_thing", "order", "product", "user"]);
    expect(structure.model.skipped).toEqual(
      expect.arrayContaining([
        { table: "session", reason: "excluded" },
        { table: "account", reason: "excluded" },
        { table: "verification", reason: "excluded" },
        { table: "order_product", reason: "bridge" },
        { table: "event_log", reason: "no-primary-key" },
      ]),
    );
  });

  it("is a valid v1 tables-structure and uses the table name as _id and type", () => {
    expect(TablesStructureResultSchema.safeParse(tablesStructureResult(structure)).success).toBe(true);
    expect(table("order")).toMatchObject({ _id: "order", type: "order", label: "Order", icon: "table" });
    expect(table("customer").description).toBe("People who buy");
    expect(Object.keys(table("customer").properties)).not.toContain("_id");
    expect(Object.keys(table("customer").properties)).not.toContain("createdAt");
    expect(structure.model.tables.customer?.pk.column).toBe("id");
    expect(structure.model.tables.customer?.createdAt?.column).toBe("created_at");
  });

  it("maps column types (05 §6.2)", () => {
    expect(prop("customer", "name").propertyType).toBe("string");
    expect(prop("customer", "phone").propertyType).toBe("string");
    expect(prop("customer", "notes")).toMatchObject({ propertyType: "long-string", description: "Internal notes" });
    expect(prop("customer", "bio").propertyType).toBe("string");
    expect(prop("order", "note").propertyType).toBe("long-string");
    expect(prop("customer", "vip").propertyType).toBe("boolean");
    expect(prop("customer", "creditLimit").propertyType).toBe("number");
    expect(prop("customer", "birthDate")).toMatchObject({ propertyType: "date", typeExtras: { date: { includeHour: false } } });
    expect(prop("customer", "lastSeenAt")).toMatchObject({ propertyType: "date", typeExtras: { date: { includeHour: true } } });
    expect(prop("customer", "preferences").propertyType).toBe("object");
    expect(prop("customer", "tags").propertyType).toBe("array");
    expect(prop("order", "status")).toMatchObject({
      propertyType: "options",
      typeExtras: {
        options: [
          { id: "pending", value: "pending" },
          { id: "paid", value: "paid" },
          { id: "shipped", value: "shipped" },
          { id: "cancelled", value: "cancelled" },
        ],
        optionsConfig: { multiple: false },
      },
    });
    expect(prop("order", "history").typeExtras).toMatchObject({ optionsConfig: { multiple: true } });
  });

  it("detects single and multiple file columns", () => {
    expect(prop("customer", "avatarImage").typeExtras).toEqual({ file: { multiple: false } });
    expect(prop("customer", "documentsFile").typeExtras).toEqual({ file: { multiple: true } }); // '[]' default
    expect(prop("product", "photosImage").typeExtras).toEqual({ file: { multiple: true } }); // CHECK
    expect(prop("product", "manualFile").typeExtras).toEqual({ file: { multiple: true } }); // sampled
    expect(prop("order", "receiptFile").typeExtras).toEqual({ file: { multiple: false } });
    const unsampled = buildStructure(loadCatalog());
    expect(unsampled.tables.find((t) => t.type === "product")?.properties.manualFile?.typeExtras).toEqual({ file: { multiple: false } });
  });

  it("honours forja:single / forja:multiple comments", () => {
    const base = loadCatalog().columns.find((c) => c.column === "receipt_file");
    if (!base) throw new Error("fixture");
    expect(staticFileMultiple({ ...base, comment: "scans forja:multiple" }, [])).toBe(true);
    expect(staticFileMultiple({ ...base, comment: "forja:single", defaultExpr: "'[]'::jsonb" }, [])).toBe(false);
    expect(staticFileMultiple(base, [])).toBeNull();
  });

  it("turns an FK into manyToOne + oneToMany with one shared id", () => {
    const fk = prop("order", "customerId");
    const back = prop("customer", "order");
    expect(fk).toMatchObject({
      propertyType: "objectReference",
      label: "Customer",
      objectReference: { objectReferenceTypeId: "customer", objectReferenceRelation: "manyToOne" },
    });
    expect(back.objectReference).toEqual({ objectReferenceTypeId: "order", objectReferenceRelation: "oneToMany" });
    expect(back.id).toBe(fk.id);
    expect(fk.id).toBe(stableId("fk:public.order.customer_id"));
    expect(prop("user", "customer").id).toBe(prop("customer", "ownerId").id);
  });

  it("turns the bridge into manyToMany on both ends with the SAME id", () => {
    const fromOrder = prop("order", "product");
    const fromProduct = prop("product", "order");
    expect(fromOrder.objectReference).toEqual({ objectReferenceTypeId: "product", objectReferenceRelation: "manyToMany" });
    expect(fromProduct.objectReference).toEqual({ objectReferenceTypeId: "order", objectReferenceRelation: "manyToMany" });
    expect(fromOrder.id).toBe(fromProduct.id);
    expect(fromOrder.id).toBe(stableId("m2m:public.order_product"));
    expect(structure.model.tables.order?.relations.find((r) => r.name === "product")).toMatchObject({
      kind: "manyToMany",
      bridge: "order_product",
      selfColumn: "order_id",
      otherColumn: "product_id",
      bridgeCreatedAt: "created_at",
    });
  });

  it("names a self reference distinctly and renames columns that collide with system fields", () => {
    expect(prop("category", "parentId").objectReference?.objectReferenceRelation).toBe("manyToOne");
    expect(prop("category", "categoryByParent")).toMatchObject({
      objectReference: { objectReferenceTypeId: "category", objectReferenceRelation: "oneToMany" },
      id: prop("category", "parentId").id,
    });
    expect(prop("customer", "metadataColumn")).toMatchObject({ propertyType: "object", label: "Metadata" });
    expect(table("customer").properties.metadata).toBeUndefined();
  });

  it("marks one display field per table", () => {
    const shown = Object.values(table("customer").properties).filter((p) => p.showInTree);
    expect(shown.map((p) => p.name)).toEqual(["name"]);
  });

  it("ids are deterministic across builds", () => {
    const again = fixtureStructure();
    expect(again.tables).toEqual(structure.tables);
  });

  it("honours a custom exclusion list", () => {
    const custom = buildStructure(loadCatalog(), { exclude: ["user"] });
    expect(custom.tables.map((t) => t.type)).toContain("session");
    expect(custom.tables.map((t) => t.type)).not.toContain("user");
    // The FK to an unexposed table is a plain column.
    expect(custom.tables.find((t) => t.type === "customer")?.properties.ownerId?.propertyType).toBe("string");
  });
});

describe("names", () => {
  it("camelCase / humanize", () => {
    expect(camelCase("order_status")).toBe("orderStatus");
    expect(camelCase("_private_x")).toBe("privateX");
    expect(camelCase("already")).toBe("already");
    expect(humanize("order_product")).toBe("Order product");
    expect(humanize("emailVerified")).toBe("Email verified");
  });
});
