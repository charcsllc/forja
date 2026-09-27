"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { formError, parseForm, type FormState } from "@/lib/form";
import { rateLimit } from "@/lib/rate-limit";
import { signInWithPassword, signOut } from "@/modules/auth";
import { safeNextPath, signInInput } from "../application/sign-in";
import { authCopy } from "@/content/auth";

export async function signInAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = parseForm(signInInput, formData);
  if (!parsed.ok) return parsed.state;

  const requestHeaders = await headers();
  const ip = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = await rateLimit(`sign-in:${ip}`, { limit: 10, window: 60 });
  if (!limit.ok) return formError(authCopy.tooManyAttempts);

  const signedIn = await signInWithPassword(parsed.data.email, parsed.data.password);
  if (!signedIn) return formError(authCopy.invalidCredentials);

  redirect(safeNextPath(parsed.data.next));
}

export async function signOutAction(): Promise<void> {
  await signOut();
  redirect("/");
}
