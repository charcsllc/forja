/**
 * Authorisation rules, independent of how the session was read. Use cases call these
 * (through `requireUser` / `requireRole` in `@/modules/auth`) as their first step.
 */
import { ForbiddenError, NotAuthenticatedError, err, ok, type Result } from "@/lib/result";
import { hasRole, type Role } from "../domain/role";
import type { SessionUser } from "../domain/session-user";

export function authorizeUser(user: SessionUser | null): Result<SessionUser, NotAuthenticatedError> {
  return user ? ok(user) : err(new NotAuthenticatedError());
}

export function authorizeRole(
  user: SessionUser | null,
  role: Role,
): Result<SessionUser, NotAuthenticatedError | ForbiddenError> {
  if (!user) return err(new NotAuthenticatedError());
  return hasRole(user.role, role) ? ok(user) : err(new ForbiddenError());
}

/** Owner-or-admin check for resources that belong to a user. */
export function authorizeOwner(
  user: SessionUser | null,
  ownerId: string,
): Result<SessionUser, NotAuthenticatedError | ForbiddenError> {
  if (!user) return err(new NotAuthenticatedError());
  return user.id === ownerId || hasRole(user.role, "admin") ? ok(user) : err(new ForbiddenError());
}
