/**
 * Column helpers every table uses (CMS conventions: the builder's database tab relies on them).
 *
 * - `id()`: primary key `id text`, UUID v7 generated in the app (`defaultRandom`).
 * - `timestamps`: `created_at` / `updated_at` `timestamptz NOT NULL DEFAULT now()`;
 *   `updated_at` is refreshed by Drizzle on every update.
 * - File fields are `jsonb` columns named `*_file` / `*_image` holding `FileRef`
 *   (`{ name, url? }`, or an array for multiple); see `fileColumn()` and `lib/storage.ts`.
 */
import { jsonb, text, timestamp } from "drizzle-orm/pg-core";
import { uuidv7 } from "../../lib/uuid";

/** A new UUID v7 string. Use as `$defaultFn(defaultRandom)` or when you need an id up front. */
export const defaultRandom = (): string => uuidv7();

export const id = () => text("id").primaryKey().$defaultFn(defaultRandom);

export const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const timestamps = () => ({ createdAt: createdAt(), updatedAt: updatedAt() });

/** What a `*_file` / `*_image` column stores. `url` is optional: storage derives it from `name`. */
export type FileRef = { name: string; url?: string };

/** A file column. The name must end in `_file` or `_image`. */
export const fileColumn = (name: `${string}_file` | `${string}_image`) => jsonb(name).$type<FileRef>();
export const filesColumn = (name: `${string}_file` | `${string}_image`) => jsonb(name).$type<FileRef[]>();
