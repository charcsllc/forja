/** Public API of the auth module. Import from `@/modules/auth`, never from its folders. */
export {
  authHandler,
  getCurrentUser,
  getSession,
  requireRole,
  requireUser,
  signInWithPassword,
  signOut,
} from "./infrastructure/container";
export { authorizeOwner, authorizeRole, authorizeUser } from "./application/authorize";
export { hasRole, isRole, ROLES, type Role } from "./domain/role";
export type { SessionUser } from "./domain/session-user";
