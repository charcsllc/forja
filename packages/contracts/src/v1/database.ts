/**
 * Database CMS shapes of API v1: table structure, the query DSL, records and links.
 *
 * Protects: the contract of docs/research/02 §6. Both sides of one relation share the
 * same `DbProperty.id`; link/unlink receive the property NAME in `propertyId` (that is
 * what the UI sends); `_count: true` puts the total in `results[0]._count._total`.
 */
import { z } from "zod";
import { openEnum } from "./known";

export const KNOWN_DB_PROPERTY_TYPES = [
  "string",
  "number",
  "date",
  "long-string",
  "options",
  "file",
  "objectReference",
  "boolean",
  "array",
  "object",
] as const;
export const DbPropertyTypeSchema = openEnum(KNOWN_DB_PROPERTY_TYPES);
export type DbPropertyType = z.infer<typeof DbPropertyTypeSchema>;

export const DbRelationSchema = z.enum(["manyToMany", "oneToMany", "manyToOne", "oneToOne"]);
export type DbRelation = z.infer<typeof DbRelationSchema>;

export const DbPropertySchema = z.object({
  /** Shared by both sides of a relation; not unique across tables. */
  id: z.string(),
  name: z.string(),
  propertyType: DbPropertyTypeSchema,
  label: z.string(),
  description: z.string().optional(),
  objectReference: z
    .object({
      /** `_id` of the target table's structure. */
      objectReferenceTypeId: z.string().optional(),
      objectReferenceRelation: DbRelationSchema.optional(),
    })
    .nullish(),
  /** `date.includeHour`, `file.multiple`, `optionsConfig.multiple`, `options[]`, … */
  typeExtras: z.record(z.string(), z.unknown()).nullish(),
  showInTree: z.boolean().nullish(),
});
export type DbProperty = z.infer<typeof DbPropertySchema>;

export const DbTableSchema = z.object({
  _id: z.string(),
  /** Table name. */
  type: z.string(),
  label: z.string(),
  description: z.string(),
  icon: z.string(),
  properties: z.record(z.string(), DbPropertySchema),
});
export type DbTable = z.infer<typeof DbTableSchema>;

/** `GET P/database/tables-structure`. */
export const TablesStructureResultSchema = z.object({ tables: z.array(DbTableSchema) });
export type TablesStructureResult = z.infer<typeof TablesStructureResultSchema>;

// ─── Query DSL ─────────────────────────────────────────────────────────────

export const FilterPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type FilterPrimitive = z.infer<typeof FilterPrimitiveSchema>;

/** Comparison operators on one field. A bare primitive means equality. */
export const FilterOperatorSchema = z
  .object({
    ne: FilterPrimitiveSchema,
    gt: z.union([z.string(), z.number()]),
    gte: z.union([z.string(), z.number()]),
    lt: z.union([z.string(), z.number()]),
    lte: z.union([z.string(), z.number()]),
    contains: z.string(),
    startsWith: z.string(),
    endsWith: z.string(),
    regex: z.string(),
    options: z.string(),
    in: z.array(FilterPrimitiveSchema),
    nin: z.array(FilterPrimitiveSchema),
  })
  .partial()
  .strict();
export type FilterOperator = z.infer<typeof FilterOperatorSchema>;

/** Relation filter: `{<link>: {_has: "some", _filter}}`. */
export type RelationFilter = { _has: "some"; _filter: FilterMap };

export type FilterValue = FilterPrimitive | FilterOperator | RelationFilter;

/** AND map of field → condition; the key `_or` holds an array of alternative maps. */
export type FilterMap = { [field: string]: FilterValue | FilterMap[] };

/*
 * The cast is deliberate: recursive schemas need an explicit type, and apps/web
 * compiles this file with `strict: false`, where zod makes every object key optional
 * and a plain annotation stops type-checking. Under this package's strict config the
 * inferred and declared types are identical.
 */
export const RelationFilterSchema = z.lazy(() =>
  z.object({ _has: z.literal("some"), _filter: FilterMapSchema }).strict(),
) as unknown as z.ZodType<RelationFilter>;

export const FilterValueSchema: z.ZodType<FilterValue> = z.lazy(() =>
  z.union([FilterPrimitiveSchema, RelationFilterSchema, FilterOperatorSchema]),
);

export const FilterMapSchema: z.ZodType<FilterMap> = z.lazy(() =>
  z.record(z.string(), z.union([FilterValueSchema, z.array(FilterMapSchema)])),
);

export const SortDirectionSchema = z.enum(["asc", "desc"]);
export type SortDirection = z.infer<typeof SortDirectionSchema>;

/** Expansion of a relation by property name: `true` (to-one) or `{_limit}` (to-many). */
export const ExpansionSchema = z.union([
  z.literal(true),
  z.object({ _limit: z.number().int().positive().optional() }).passthrough(),
]);
export type Expansion = z.infer<typeof ExpansionSchema>;

const RESERVED_QUERY_KEYS = new Set(["_limit", "_offset", "_sort", "_filter", "_count"]);

/**
 * `queryOptions`. Reserved keys start with `_`; any other top-level key is an
 * expansion by property name, checked against `ExpansionSchema`. The inferred type keeps
 * an `unknown` index signature so literals with reserved keys stay assignable.
 */
export const QueryOptionsSchema = z
  .object({
    _limit: z.number().int().positive().optional(),
    _offset: z.number().int().nonnegative().optional(),
    _sort: z.record(z.string(), SortDirectionSchema).optional(),
    _filter: FilterMapSchema.optional(),
    _count: z.boolean().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const [key, expansion] of Object.entries(value)) {
      if (RESERVED_QUERY_KEYS.has(key)) continue;
      if (!ExpansionSchema.safeParse(expansion).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "An expansion must be `true` or `{ _limit }`",
        });
      }
    }
  });
export type QueryOptions = z.infer<typeof QueryOptionsSchema>;

/** `POST P/database/query`. */
export const DbQueryRequestSchema = z.object({
  tableName: z.string().min(1),
  queryOptions: QueryOptionsSchema,
});
export type DbQueryRequest = z.infer<typeof DbQueryRequestSchema>;

/** A row: `_id` plus system fields and any column; `_count` only on the first row. */
export const DbRowSchema = z
  .object({
    _id: z.string(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    _count: z.object({ _total: z.number().int() }).optional(),
  })
  .catchall(z.unknown());
export type DbRow = z.infer<typeof DbRowSchema>;

export const DbQueryResultSchema = z.object({ results: z.array(DbRowSchema) });
export type DbQueryResult = z.infer<typeof DbQueryResultSchema>;

/** `POST P/database/records` and `PATCH …/records/{id}`. */
export const DbRecordWriteRequestSchema = z.object({
  tableName: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});
export type DbRecordWriteRequest = z.infer<typeof DbRecordWriteRequestSchema>;

/** `POST|DELETE …/records/{id}/link` (DELETE carries this JSON body too). */
export const DbLinkRequestSchema = z.object({
  tableName: z.string().min(1),
  /** The property NAME, despite the field name. */
  propertyId: z.string().min(1),
  referenceId: z.string().min(1),
});
export type DbLinkRequest = z.infer<typeof DbLinkRequestSchema>;

/** A file field value: write `{name}` (= upload `fileNameId`), read adds `url`/`type`. */
export const DbFileValueSchema = z.object({
  name: z.string(),
  url: z.string().optional(),
  type: z.string().optional(),
});
export type DbFileValue = z.infer<typeof DbFileValueSchema>;
