/**
 * zod (v3) → JSON Schema for tool definitions sent to the model.
 *
 * What this protects: the schema a model sees is derived from the SAME zod schema the loop
 * validates arguments against (docs/architecture/02 §4 invariant 2), so the two can never
 * drift. No dependency: zod 3 has no converter and `zod-to-json-schema` is not installed.
 *
 * Supported: object (strict or passthrough), string (min/max/regex/url/email), number
 * (int/min/max), boolean, literal, enum, native enum of strings, array (min/max), record,
 * union, discriminated union, optional/default/nullable/nullish, effects (refine,
 * preprocess, transform: the input side), lazy (one level), any/unknown. Anything else
 * becomes `{}` (accept anything), which is safe because zod still validates.
 */
import { z } from "zod";

export type JsonSchemaObject = { [key: string]: unknown };

interface Options {
  /** Keeps the output small: descriptions of nested fields are dropped past this depth. */
  maxDescriptionDepth?: number;
}

function withDescription(schema: z.ZodTypeAny, out: JsonSchemaObject, depth: number, opts: Options): JsonSchemaObject {
  const description = schema.description;
  if (description && depth <= (opts.maxDescriptionDepth ?? 8)) out.description = description;
  return out;
}

/** Whether a zod type accepts `undefined` (an optional property). */
function isOptional(schema: z.ZodTypeAny): boolean {
  return schema.isOptional();
}

function convert(schema: z.ZodTypeAny, depth: number, opts: Options): JsonSchemaObject {
  const def = schema._def as { typeName?: string } & Record<string, unknown>;
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString: {
      const out: JsonSchemaObject = { type: "string" };
      for (const check of (def.checks as { kind: string; value?: number; regex?: RegExp }[]) ?? []) {
        if (check.kind === "min") out.minLength = check.value;
        else if (check.kind === "max") out.maxLength = check.value;
        else if (check.kind === "length") {
          out.minLength = check.value;
          out.maxLength = check.value;
        } else if (check.kind === "regex" && check.regex) out.pattern = check.regex.source;
        else if (check.kind === "url") out.format = "uri";
        else if (check.kind === "email") out.format = "email";
      }
      return withDescription(schema, out, depth, opts);
    }
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const out: JsonSchemaObject = { type: "number" };
      for (const check of (def.checks as { kind: string; value?: number; inclusive?: boolean }[]) ?? []) {
        if (check.kind === "int") out.type = "integer";
        else if (check.kind === "min") out[check.inclusive === false ? "exclusiveMinimum" : "minimum"] = check.value;
        else if (check.kind === "max") out[check.inclusive === false ? "exclusiveMaximum" : "maximum"] = check.value;
      }
      return withDescription(schema, out, depth, opts);
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return withDescription(schema, { type: "boolean" }, depth, opts);
    case z.ZodFirstPartyTypeKind.ZodLiteral: {
      const value = def.value as unknown;
      const type = typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string";
      return withDescription(schema, { type, const: value, enum: [value] }, depth, opts);
    }
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return withDescription(schema, { type: "string", enum: [...(def.values as string[])] }, depth, opts);
    case z.ZodFirstPartyTypeKind.ZodNativeEnum: {
      const values = Object.values(def.values as Record<string, string | number>).filter((v) => typeof v === "string");
      return withDescription(schema, { type: "string", enum: values }, depth, opts);
    }
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const out: JsonSchemaObject = { type: "array", items: convert(def.type as z.ZodTypeAny, depth + 1, opts) };
      const min = def.minLength as { value: number } | null;
      const max = def.maxLength as { value: number } | null;
      if (min) out.minItems = min.value;
      if (max) out.maxItems = max.value;
      return withDescription(schema, out, depth, opts);
    }
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      const properties: Record<string, JsonSchemaObject> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convert(value, depth + 1, opts);
        if (!isOptional(value)) required.push(key);
      }
      const out: JsonSchemaObject = { type: "object", properties };
      if (required.length > 0) out.required = required;
      const unknownKeys = def.unknownKeys as string | undefined;
      if (unknownKeys === "strict") out.additionalProperties = false;
      return withDescription(schema, out, depth, opts);
    }
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return withDescription(
        schema,
        { type: "object", additionalProperties: convert(def.valueType as z.ZodTypeAny, depth + 1, opts) },
        depth,
        opts,
      );
    case z.ZodFirstPartyTypeKind.ZodUnion:
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
      const options = (Array.isArray(def.options) ? def.options : [...(def.options as Map<unknown, z.ZodTypeAny>).values()]) as z.ZodTypeAny[];
      return withDescription(schema, { anyOf: options.map((o) => convert(o, depth + 1, opts)) }, depth, opts);
    }
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return withDescription(schema, convert(def.innerType as z.ZodTypeAny, depth, opts), depth, opts);
    case z.ZodFirstPartyTypeKind.ZodDefault: {
      const inner = convert(def.innerType as z.ZodTypeAny, depth, opts);
      const value = (def.defaultValue as () => unknown)();
      return withDescription(schema, { ...inner, default: value }, depth, opts);
    }
    case z.ZodFirstPartyTypeKind.ZodNullable: {
      const inner = convert(def.innerType as z.ZodTypeAny, depth, opts);
      return withDescription(schema, { anyOf: [inner, { type: "null" }] }, depth, opts);
    }
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return withDescription(schema, convert(def.schema as z.ZodTypeAny, depth, opts), depth, opts);
    case z.ZodFirstPartyTypeKind.ZodLazy:
      return depth > 12 ? {} : convert((def.getter as () => z.ZodTypeAny)(), depth + 1, opts);
    case z.ZodFirstPartyTypeKind.ZodBranded:
    case z.ZodFirstPartyTypeKind.ZodReadonly:
    case z.ZodFirstPartyTypeKind.ZodCatch:
      return convert((def.type ?? def.innerType) as z.ZodTypeAny, depth, opts);
    case z.ZodFirstPartyTypeKind.ZodPipeline:
      return convert(def.in as z.ZodTypeAny, depth, opts);
    default:
      return withDescription(schema, {}, depth, opts);
  }
}

/** The JSON Schema of a tool's input. The root is always an object schema. */
export function toJsonSchema(schema: z.ZodTypeAny, opts: Options = {}): JsonSchemaObject {
  const out = convert(schema, 0, opts);
  if (out.type !== "object") return { type: "object", properties: {}, ...out };
  return out;
}
