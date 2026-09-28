/**
 * The secret redactor (11-tool-registry.md, 07 §1): every tool output passes through it
 * before it reaches the model or `run_events`.
 *
 * What this protects: a secret value of the project, or anything shaped like a provider
 * key, never enters a prompt, an event or a log. Known values are replaced exactly (values
 * shorter than 6 characters are ignored: replacing "1" everywhere would destroy output);
 * patterns catch keys the engine does not know about.
 */
export const REDACTED = "[redacted]";

/** Key shapes of common providers. Conservative: long, prefixed tokens only. */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}/g,
  /\bnvapi-[A-Za-z0-9_-]{20,}/g,
  /\btlm_sk_[A-Za-z0-9_-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function createRedactor(knownValues: Iterable<string> = []): (text: string) => string {
  const values = [...new Set([...knownValues].filter((v) => typeof v === "string" && v.length >= 6))].sort(
    (a, b) => b.length - a.length,
  );
  return (text: string): string => {
    if (!text) return text;
    let out = text;
    for (const value of values) if (out.includes(value)) out = out.split(value).join(REDACTED);
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
    return out;
  };
}
