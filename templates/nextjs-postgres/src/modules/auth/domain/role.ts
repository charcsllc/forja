/** Roles, from least to most privileged. Mirrors the `user_role` Postgres enum. */
export const ROLES = ["user", "admin"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** True when `actual` is `required` or more privileged. */
export function hasRole(actual: Role, required: Role): boolean {
  return ROLES.indexOf(actual) >= ROLES.indexOf(required);
}
