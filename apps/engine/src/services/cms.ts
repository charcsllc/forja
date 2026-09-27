/**
 * The Database tab's port (research/02 §6, 05 §6).
 *
 * Protects: the routes only see this interface. The implementation over `@forja/db-cms`
 * (`cms-dbcms.ts`) owns the per-project connections (`cms_ro` for reads, `cms_rw` for
 * writes, over the project's internal network) and is the only engine file that imports
 * that package, so a change in its API touches one adapter.
 */
export interface LinkInput {
  tableName: string;
  recordId: string;
  /** The property NAME (the UI sends the name as `propertyId`). */
  propertyId: string;
  referenceId: string;
}

export interface CmsPort {
  tablesStructure(projectId: string): Promise<{ tables: unknown[] }>;
  query(projectId: string, tableName: string, queryOptions: Record<string, unknown>): Promise<{ results: unknown[] }>;
  createRecord(projectId: string, tableName: string, data: Record<string, unknown>): Promise<unknown>;
  updateRecord(projectId: string, tableName: string, recordId: string, data: Record<string, unknown>): Promise<unknown>;
  deleteRecord(projectId: string, tableName: string, recordId: string): Promise<unknown>;
  link(projectId: string, input: LinkInput): Promise<unknown>;
  unlink(projectId: string, input: LinkInput): Promise<unknown>;
  /** Drop pooled connections (archive, delete, password change). */
  release(projectId: string): Promise<void>;
  close(): Promise<void>;
}
