import type { Role } from "./role";

/** The signed-in user as the application sees it. */
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
};
