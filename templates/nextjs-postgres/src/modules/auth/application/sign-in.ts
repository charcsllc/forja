import { z } from "zod";

/** Shared by the sign-in form (client validation) and its server action. */
export const signInInput = z.object({
  email: z.email("Enter a valid email address").transform((value) => value.toLowerCase()),
  password: z.string().min(8, "Passwords have at least 8 characters").max(128),
  next: z.string().optional(),
});

/** Only same-site relative paths are allowed as post-sign-in destinations. */
export function safeNextPath(value: string | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/";
}
