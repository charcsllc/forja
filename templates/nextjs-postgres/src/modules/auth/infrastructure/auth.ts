/**
 * BetterAuth, configured once. Email + password is on; add OAuth providers under
 * `socialProviders` with optional env keys (and hide their buttons when a key is missing).
 * Created lazily so `next build` does not need secrets or a database.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { env, trustedOrigins } from "@/env";
import { getDb } from "@/db/client";
import { account, session, user, verification } from "@/db/schema";
import { defaultRandom } from "@/db/schema/columns";
import { sendMail } from "@/lib/mailer";
import { site } from "@/content/site";

function createAuth() {
  return betterAuth({
    appName: site.name,
    baseURL: env.NEXT_PUBLIC_APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: trustedOrigins(),
    database: drizzleAdapter(getDb(), { provider: "pg", schema: { user, session, account, verification } }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      sendResetPassword: async ({ user: target, url }) => {
        await sendMail({
          to: target.email,
          subject: `Reset your ${site.name} password`,
          text: `Reset your password: ${url}`,
        });
      },
    },
    user: {
      additionalFields: {
        role: { type: "string", required: false, defaultValue: "user", input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: { enabled: env.NODE_ENV === "production", window: 60, max: 100 },
    advanced: {
      database: { generateId: () => defaultRandom() },
      useSecureCookies: env.NEXT_PUBLIC_APP_URL.startsWith("https://"),
    },
    telemetry: { enabled: false },
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as unknown as { __appAuth?: Auth };

export function getAuth(): Auth {
  return (globalForAuth.__appAuth ??= createAuth());
}
