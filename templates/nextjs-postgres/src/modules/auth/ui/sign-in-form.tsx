"use client";

import { Button } from "@/components/ui/button";
import { FieldError, Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useForm } from "@/lib/use-form";
import { authCopy } from "@/content/auth";
import { signInInput } from "../application/sign-in";
import { signInAction } from "./actions";

export function SignInForm({ next }: { next?: string }) {
  const form = useForm(signInInput, signInAction);

  return (
    <form action={form.action} className="grid gap-4" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <div className="grid gap-2">
        <Label htmlFor="email">{authCopy.email}</Label>
        <Input {...form.field("email")} type="email" autoComplete="email" required />
        <FieldError id={form.errorId("email")}>{form.error("email")}</FieldError>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="password">{authCopy.password}</Label>
        <Input {...form.field("password")} type="password" autoComplete="current-password" required />
        <FieldError id={form.errorId("password")}>{form.error("password")}</FieldError>
      </div>
      {form.state.status === "error" && form.state.message ? (
        <p role="alert" className="text-sm text-danger">
          {form.state.message}
        </p>
      ) : null}
      <Button type="submit" disabled={form.pending}>
        {form.pending ? authCopy.signingIn : authCopy.signIn}
      </Button>
    </form>
  );
}
