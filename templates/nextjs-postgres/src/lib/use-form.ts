"use client";
/**
 * Client half of `lib/form.ts`: wraps `useActionState`, validates a field on blur with the
 * same zod schema the server uses, and exposes accessible props per field.
 *
 *   const form = useForm(schema, save);
 *   <form action={form.action}>
 *     <Input {...form.field("email")} type="email" />
 *     <FieldError id={form.errorId("email")}>{form.error("email")}</FieldError>
 */
import { useActionState, useState, type FocusEvent } from "react";
import type { z } from "zod";
import { fieldErrorsOf, initialFormState, type FieldErrors, type FormState } from "@/lib/form";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

export function useForm<S extends z.ZodObject>(schema: S, serverAction: Action) {
  const [state, action, pending] = useActionState(serverAction, initialFormState);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});

  const serverErrors = state.status === "error" ? (state.fieldErrors ?? {}) : {};

  const validate = (name: string, value: string) => {
    const fieldSchema = (schema.shape as Record<string, z.ZodType | undefined>)[name];
    if (!fieldSchema) return;
    const parsed = fieldSchema.safeParse(value);
    setClientErrors((previous) => ({
      ...previous,
      [name]: parsed.success ? undefined : fieldErrorsOf(parsed.error)._form,
    }));
  };

  const error = (name: string): string | undefined => (clientErrors[name] ?? serverErrors[name])?.[0];
  const errorId = (name: string) => `${name}-error`;

  const field = (name: string) => ({
    id: name,
    name,
    defaultValue: state.status === "error" ? state.values?.[name] : undefined,
    "aria-invalid": error(name) ? true : undefined,
    "aria-describedby": error(name) ? errorId(name) : undefined,
    onBlur: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      validate(name, event.target.value),
  });

  return { state, action, pending, error, errorId, field };
}
