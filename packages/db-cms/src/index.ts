/**
 * `@forja/db-cms`: the database tab over a project's own Postgres (docs/architecture/05 §6).
 *
 * Protects: the engine reaches project data for the CMS only through these functions,
 * which accept the UI's Totalum DSL, resolve every name against an introspected model,
 * and run parameterized SQL under a statement timeout. Errors are `CmsError`s.
 *
 * Typical use (engine):
 *   const structure = await introspect(cmsRo);                  // cache per project
 *   res.json(tablesStructureResult(structure));                 // GET tables-structure
 *   await executeQuery(cmsRo, structure, tableName, queryOptions, { resolveFileUrl });
 *   await createRecord(cmsRw, structure, tableName, data, { resolveFileUrl });
 *   await link(cmsRw, structure, tableName, id, propertyName, referenceId);
 */
export { CMS_ERROR_CODES, CMS_ERROR_STATUS, CmsError, isCmsError, mapPgError, type CmsErrorCode, type CmsErrorDetails } from "./errors.js";
export type {
  CmsColumn,
  CmsModel,
  CmsRelation,
  CmsStructure,
  CmsTableModel,
  ColumnKind,
  ManyToManyRelation,
  ManyToOneRelation,
  OneToManyRelation,
  SkippedTable,
} from "./model.js";
export { camelCase, humanize, stableId } from "./names.js";
export {
  DEFAULT_EXCLUDED_TABLES,
  buildStructure,
  fetchCatalog,
  introspect,
  tablesStructureResult,
  type BuildStructureOptions,
  type Catalog,
  type CatalogColumn,
  type CatalogConstraint,
  type IntrospectOptions,
} from "./introspect.js";
export {
  DEFAULT_LIMIT,
  MAX_EXPAND_LIMIT,
  MAX_FILTER_DEPTH,
  MAX_LIMIT,
  compileQuery,
  filterText,
  type CompiledQuery,
  type ExpansionPlan,
  type QueryPlan,
} from "./compile.js";
export { decodeRow, type DecodeOptions, type FileUrlResolver } from "./rows.js";
export { encodeWrite, type EncodedWrite } from "./values.js";
export {
  createRecord,
  deleteRecord,
  executeQuery,
  link,
  resolveLinkProperty,
  unlink,
  updateRecord,
  type CmsOptions,
  type LinkResult,
} from "./records.js";
export { DEFAULT_STATEMENT_TIMEOUT_MS, withCmsTransaction, type CmsCallOptions } from "./tx.js";
export { uuidv7 } from "./uuid.js";
export type { SqlTag } from "./sqlkit.js";
