/**
 * Composition root of the auth module: binds the application rules to BetterAuth and
 * Next.js request context. Import it through `@/modules/auth`.
 */
import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import type { ForbiddenError, NotAuthenticatedError, Result } from "@/lib/result";
import { authorizeRole, authorizeUser } from "../application/authorize";
import { isRole, type Role } from "../domain/role";
import type { SessionUser } from "../domain/session-user";
import { getAuth } from "./auth";

/** The current session (user + session record), or `null` when signed out. */
export async function getSession() {
  return getAuth().api.getSession({ headers: await headers() });
}

/** The signed-in user in application shape, or `null`. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const current = await getSession();
  if (!current) return null;
  const { id, email, name } = current.user;
  const role = (current.user as { role?: unknown }).role;
  return { id, email, name, role: isRole(role) ? role : "user" };
}

/** Result with the signed-in user, or `NotAuthenticatedError` (401). */
export async function requireUser(): Promise<Result<SessionUser, NotAuthenticatedError>> {
  return authorizeUser(await getCurrentUser());
}

/** Result with the user when they hold `role` (or higher); 401 / 403 errors otherwise. */
export async function requireRole(role: Role): Promise<Result<SessionUser, NotAuthenticatedError | ForbiddenError>> {
  return authorizeRole(await getCurrentUser(), role);
}

/** Route handler for `/api/auth/*`. */
export function authHandler(request: Request): Promise<Response> {
  return getAuth().handler(request);
}

/** Sign in with email + password, setting the session cookie (server actions only). */
export async function signInWithPassword(email: string, password: string): Promise<boolean> {
  try {
    await getAuth().api.signInEmail({ body: { email, password }, headers: await headers() });
    return true;
  } catch (error) {
    if (error instanceof APIError) return false; // wrong email or password
    throw error;
  }
}

/** Sign out, clearing the session cookie (server actions only). */
export async function signOut(): Promise<void> {
  await getAuth().api.signOut({ headers: await headers() });
}
