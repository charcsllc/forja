/**
 * Open string enums: a known list of values plus "any other string".
 *
 * Protects: forward compatibility of fields whose value set is owned by someone else
 * (Cloudflare domain states, Totalum property types). A value we have never seen must
 * still parse, so the UI degrades instead of crashing, while the known values keep
 * their autocomplete in TypeScript.
 */
import { z } from "zod";

/** `Known | (string & {})`: known literals stay suggestible, any string is assignable. */
export type OpenEnum<Known extends string> = Known | (string & {});

/** Schema that accepts any string but is typed as the open enum of `known`. */
export function openEnum<const Known extends readonly [string, ...string[]]>(
  _known: Known,
): z.ZodType<OpenEnum<Known[number]>> {
  return z.custom<OpenEnum<Known[number]>>((value) => typeof value === "string", {
    message: "Expected a string",
  });
}
