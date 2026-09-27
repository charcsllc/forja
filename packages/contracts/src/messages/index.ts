/**
 * Localized user-visible messages: language detection, catalogues and interpolation.
 *
 * Protects: the engine never builds a conversation message by string concatenation;
 * it goes through `t()` with a key from the `en` catalogue, in the project's language
 * (`projects.language`, detected from the first prompt).
 */
import type { AgentRole, RunStatus } from "../plan";
import { en, type MessageCatalog, type MessageKey } from "./en";
import { es } from "./es";

export { en, es };
export type { MessageCatalog, MessageKey };

export const SUPPORTED_LANGUAGES = ["en", "es"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";

const CATALOGS: Readonly<Record<Language, Readonly<Record<MessageKey, string>>>> = { en, es };

/** The catalogue of one language. */
export function messages(lang: Language): Readonly<Record<MessageKey, string>> {
  return CATALOGS[lang];
}

export function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "es";
}

/** Placeholder names of a template literal type: `"a {x} b {y}"` → `"x" | "y"`. */
export type TemplateParams<S extends string> = S extends `${string}{${infer P}}${infer Rest}`
  ? P | TemplateParams<Rest>
  : never;

export type ParamsFor<K extends MessageKey> = Record<TemplateParams<MessageCatalog[K]>, string | number>;

type ParamArgs<K extends MessageKey> = [TemplateParams<MessageCatalog[K]>] extends [never]
  ? [params?: Record<string, never>]
  : [params: ParamsFor<K>];

/**
 * Interpolate a message. Placeholders are typed from the English catalogue; a
 * placeholder without a value is left verbatim (visible in review, never a crash).
 */
export function t<K extends MessageKey>(lang: Language, key: K, ...args: ParamArgs<K>): string {
  const template = CATALOGS[lang][key];
  const params: Record<string, string | number> = args[0] ?? {};
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** The phase message for a run status. */
export function phaseMessage(lang: Language, status: RunStatus): string {
  return t(lang, `phase.${status}`);
}

const NAMED_TASK_ROLES = new Set<AgentRole>(["frontend", "backend", "database"]);

/**
 * The "task started" message. `title` must already be user-facing text in `lang` (a
 * page name, a feature name); it is only used by roles whose work maps to something the
 * user named. Never pass a task id or a role name.
 */
export function taskStartedMessage(lang: Language, role: AgentRole, title?: string): string {
  const name = title?.trim();
  if (name && NAMED_TASK_ROLES.has(role)) {
    const key = `task.${role}.named` as "task.frontend.named";
    return t(lang, key, { title: name });
  }
  return t(lang, `task.${role}`);
}

/** Gate progress message, e.g. "Comprobando 6 de 11 verificaciones". */
export function gatesProgressMessage(lang: Language, done: number, total: number): string {
  return t(lang, "gates.progress", { done, total });
}

// ─── Language detection ──────────────────────────────────────────────────────

const ES_WORDS = new Set([
  "el", "la", "los", "las", "de", "del", "que", "y", "en", "un", "una", "unos", "unas",
  "para", "con", "por", "al", "es", "son", "mi", "mis", "tu", "su", "sus", "quiero",
  "necesito", "crea", "crear", "haz", "hacer", "hazme", "añade", "añadir", "pon", "cambia",
  "página", "pagina", "tienda", "web", "aplicación", "aplicacion", "como", "pero", "muy",
  "donde", "cuando", "también", "tambien", "usuarios", "botón", "boton", "gracias", "hola",
]);

const EN_WORDS = new Set([
  "the", "and", "to", "of", "for", "with", "i", "want", "need", "create", "build", "make",
  "my", "is", "are", "in", "that", "this", "page", "app", "website", "store", "shop", "add",
  "change", "please", "users", "button", "on", "it", "should", "can", "from", "an", "hello",
  "thanks", "where", "when", "also", "but", "very",
]);

/**
 * Heuristic Spanish/English detector for the first prompt. Counts function words of
 * each language plus Spanish-only characters (`ñ`, `¿`, `¡`, accented vowels, weighted
 * double). Ties and empty input fall back to English.
 */
export function detectLanguage(prompt: string): Language {
  const text = prompt.toLowerCase();
  const words = text.match(/[\p{L}]+/gu) ?? [];
  let es = 0;
  let en = 0;
  for (const word of words) {
    if (ES_WORDS.has(word)) es += 1;
    if (EN_WORDS.has(word)) en += 1;
  }
  es += 2 * (text.match(/[ñ¿¡áéíóú]/g)?.length ?? 0);
  return es > en ? "es" : "en";
}
