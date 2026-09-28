/** zod → JSON Schema. Protects: the schema the model sees matches what the loop validates. */
import { RunPlanSchema, TaskReportSchema } from "@forja/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toJsonSchema } from "../src/tools/json-schema.js";

describe("toJsonSchema", () => {
  it("converts objects, optionals, defaults, enums, arrays and checks", () => {
    const s = toJsonSchema(
      z.object({
        path: z.string().min(1).describe("a path"),
        n: z.number().int().min(1).max(400).optional(),
        kind: z.enum(["a", "b"]),
        tags: z.array(z.string()).max(3).default([]),
        maybe: z.string().nullable(),
        re: z.string().regex(/^[a-z]+$/),
      }),
    );
    expect(s).toEqual({
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "a path" },
        n: { type: "integer", minimum: 1, maximum: 400 },
        kind: { type: "string", enum: ["a", "b"] },
        tags: { type: "array", items: { type: "string" }, maxItems: 3, default: [] },
        maybe: { anyOf: [{ type: "string" }, { type: "null" }] },
        re: { type: "string", pattern: "^[a-z]+$" },
      },
      required: ["path", "kind", "maybe", "re"],
    });
  });

  it("handles the contract schemas (effects, records, partials, unions)", () => {
    const plan = toJsonSchema(RunPlanSchema) as { required: string[]; properties: Record<string, { type?: string }> };
    expect(plan.required).toEqual(expect.arrayContaining(["intent", "summary", "spec", "tasks", "budgetWeights", "verification"]));
    expect(plan.properties.budgetWeights).toMatchObject({ type: "object", additionalProperties: { type: "number" } });
    const report = toJsonSchema(TaskReportSchema) as { required: string[] };
    expect(report.required).toEqual(["status", "summary", "filesChanged", "acceptance"]);
    expect(JSON.stringify(toJsonSchema(z.discriminatedUnion("k", [z.object({ k: z.literal("a") }), z.object({ k: z.literal("b") })])))).toContain("anyOf");
  });

  it("always yields an object at the root", () => {
    expect(toJsonSchema(z.object({}))).toEqual({ type: "object", properties: {} });
  });
});
