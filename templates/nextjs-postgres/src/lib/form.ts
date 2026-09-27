/**
 * Forms: one zod schema shared by the client (inline validation) and the server action
 * (authoritative validation). Server-safe; the client hook lives in `lib/use-form.ts`.
 *
 *   // actions.ts ("use server")
 *   export async function save(_: FormState, formData: FormData): Promise<FormState> {
 *     const parsed = parseForm(schema, formData);
 *     if (!parsed.ok) return parsed.state;
 *     ...
 *     return formSuccess("Saved");
 *   }
 */
import { type z } from "zod";

export type FieldErrors = Record<string, string[] | undefined>;

export type FormState =
  | { status: "idle" }
  | { status: "success"; message?: string }
  | { status: "error"; message?: string; fieldErrors?: FieldErrors; values?: Record<string, string> };

export const initialFormState: FormState = { status: "idle" };

/** FormData → plain object. Repeated keys become arrays; `$ACTION_*` internals are dropped. */
export function formDataToObject(formData: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("$ACTION")) continue;
    const current = out[key];
    if (current === undefined) out[key] = value;
    else out[key] = Array.isArray(current) ? [...current, value] : [current, value];
  }
  return out;
}

/** Echo text values back so a failed submit keeps what the user typed (never passwords). */
function echoValues(input: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && !/password|secret|token/i.test(key)) values[key] = value;
  }
  return values;
}

export function fieldErrorsOf(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join(".") : "_form";
    (errors[key] ??= []).push(issue.message);
  }
  return errors;
}

export function parseForm<S extends z.ZodType>(
  schema: S,
  formData: FormData,
): { ok: true; data: z.output<S> } | { ok: false; state: FormState } {
  const input = formDataToObject(formData);
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    state: {
      status: "error",
      message: "Please fix the highlighted fields.",
      fieldErrors: fieldErrorsOf(parsed.error),
      values: echoValues(input),
    },
  };
}

export const formSuccess = (message?: string): FormState => ({ status: "success", message });
export const formError = (message: string, fieldErrors?: FieldErrors): FormState => ({
  status: "error",
  message,
  fieldErrors,
});
