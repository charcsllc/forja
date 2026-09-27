/**
 * Write coercion (research/02 §6: "coercion of numbers, booleans, ISO dates and JSON;
 * to-one → id|null; to-many never written; files stored as {name}") and row decoding
 * (ISO timestamps, file urls from the resolver, ids as strings).
 */
import { describe, expect, it } from "vitest";
import { decodeRow, encodeWrite, isCmsError, uuidv7, type CmsTableModel } from "../src/index.js";
import { fixtureStructure } from "./fixture.js";

const { model } = fixtureStructure();
const table = (name: string): CmsTableModel => {
  const found = model.tables[name];
  if (!found) throw new Error(name);
  return found;
};

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isCmsError(error)) return error.code;
    throw error;
  }
  return "OK";
}

describe("encodeWrite", () => {
  it("coerces by column type and keys the record by SQL column", () => {
    const { record, columns } = encodeWrite(table("customer"), {
      name: "Ana",
      vip: "true",
      visits: "3",
      creditLimit: 12.5,
      birthDate: "1990-02-03T00:00:00.000Z",
      lastSeenAt: "2026-01-01T10:00:00+02:00",
      preferences: { theme: "dark" },
      tags: ["x", "y"],
      avatarImage: { name: "a.png", url: "https://signed/a.png?sig=1", type: "image" },
      documentsFile: [{ name: "a.pdf", url: "x" }, "b.pdf"],
      ownerId: { _id: "usr_1", name: "Ada" },
    });
    expect(record).toEqual({
      name: "Ana",
      vip: true,
      visits: "3",
      credit_limit: "12.5",
      birth_date: "1990-02-03",
      last_seen_at: "2026-01-01T08:00:00.000Z",
      preferences: { theme: "dark" },
      tags: ["x", "y"],
      avatar_image: { name: "a.png" },
      documents_file: [{ name: "a.pdf" }, { name: "b.pdf" }],
      owner_id: "usr_1",
    });
    expect(columns.map((c) => c.column)).toContain("owner_id");
  });

  it("treats empty strings on non-text columns as empty and keeps them on text", () => {
    expect(encodeWrite(table("customer"), { email: "", visits: "", ownerId: "", birthDate: "" }).record).toEqual({
      email: "",
      visits: null,
      owner_id: null,
      birth_date: null,
    });
  });

  it("ignores system fields and to-many relations, refuses unknown properties", () => {
    expect(encodeWrite(table("order"), { _id: "x", createdAt: "y", product: ["prd_01"], note: "n" }).record).toEqual({ note: "n" });
    expect(code(() => encodeWrite(table("order"), { nope: 1 }))).toBe("PROPERTY_NOT_FOUND");
  });

  it("refuses values that cannot be coerced", () => {
    expect(code(() => encodeWrite(table("order"), { status: "lost" }))).toBe("VALIDATION");
    expect(code(() => encodeWrite(table("order"), { history: ["paid", "lost"] }))).toBe("VALIDATION");
    expect(code(() => encodeWrite(table("order"), { number: 1.5 }))).toBe("VALIDATION");
    expect(code(() => encodeWrite(table("order"), { number: "abc" }))).toBe("VALIDATION");
    expect(code(() => encodeWrite(table("customer"), { vip: "maybe" }))).toBe("VALIDATION");
    expect(code(() => encodeWrite(table("customer"), { birthDate: "someday" }))).toBe("VALIDATION");
    expect(code(() => encodeWrite(table("customer"), { avatarImage: { url: "x" } }))).toBe("VALIDATION");
    expect(code(() => encodeWrite(table("customer"), { name: { x: 1 } }))).toBe("VALIDATION");
    expect(code(() => encodeWrite(table("customer"), "nope"))).toBe("VALIDATION");
  });

  it("sends plain digits to integer columns", () => {
    expect(encodeWrite(table("order"), { number: "1e3" }).record).toEqual({ number: "1000" });
  });
});

describe("decodeRow", () => {
  it("returns ISO timestamps, string ids and resolver urls for files", async () => {
    const row = await decodeRow(
      model,
      table("customer"),
      {
        _id: "cus_1",
        createdAt: "2026-01-01T01:00:00+01:00",
        updatedAt: "2026-01-01T00:00:00+00:00",
        name: "A",
        lastSeenAt: "2026-06-01T12:00:00+00:00",
        avatarImage: { name: "a.png", url: "stale" },
        documentsFile: { name: "one.pdf" },
        ownerId: "usr_1",
      },
      [],
      { resolveFileUrl: (name) => `https://files/${name}` },
    );
    expect(row).toMatchObject({
      _id: "cus_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-06-01T12:00:00.000Z",
      avatarImage: { name: "a.png", url: "https://files/a.png", type: "image" },
      documentsFile: [{ name: "one.pdf", url: "https://files/one.pdf" }],
      ownerId: "usr_1",
    });
  });
});

describe("uuidv7", () => {
  it("is a version 7 RFC 9562 uuid ordered by time", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
