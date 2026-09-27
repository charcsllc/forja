/**
 * Naming rules of the CMS: snake_case ↔ camelCase, human labels, stable property ids and
 * the identifier check.
 *
 * Protects: (1) property ids are deterministic, so both sides of one relation share the
 * same `DbProperty.id` across introspections (the UI pairs halves by it); (2) no
 * identifier that postgres.js would split or mangle (dots, empties, NUL) ever reaches SQL.
 */
import { createHash } from "node:crypto";

/** `order_status` → `orderStatus`; `_foo` → `foo`; `fooBar` is kept. */
export function camelCase(snake: string): string {
  const trimmed = snake.replace(/^_+/, "");
  const camel = trimmed.replace(/_+([^_])/g, (_match, char: string) => char.toUpperCase()).replace(/_+$/, "");
  return camel === "" ? snake : camel;
}

/** `order_product` → `Order product`; `customer_id` → `Customer id`; `emailVerified` → `Email verified`. */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\s]+/g, " ")
    .trim()
    .toLowerCase();
  if (words === "") return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Label of an FK column: `customer_id` → `Customer`. */
export function humanizeReference(column: string): string {
  return humanize(column.replace(/_?id$/i, "") || column);
}

/** 12 url-safe characters derived from `seed` (sha1). Same seed, same id, forever. */
export function stableId(seed: string): string {
  return createHash("sha1").update(seed).digest("base64url").slice(0, 12);
}

/**
 * Identifiers the CMS will put in SQL. postgres.js splits `sql(name)` on dots, so a name
 * with a dot (legal when quoted) would address the wrong object; such tables and columns
 * are skipped by introspection.
 */
export function isSafeIdentifier(name: string): boolean {
  return name.length > 0 && name.length <= 63 && !name.includes(".") && !name.includes("\u0000");
}
