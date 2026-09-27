/**
 * Renders a postgres.js fragment to `{text, params}` offline, walking `strings`/`args`
 * exactly as postgres.js's own `stringify` does (nested fragments inline, identifiers
 * escaped, everything else becomes `$n`). Never awaits the fragment, so nothing runs.
 */
interface QueryLike {
  strings: readonly string[];
  args: readonly unknown[];
}

function isQuery(value: unknown): value is QueryLike {
  return typeof value === "object" && value !== null && Array.isArray((value as QueryLike).strings) && Array.isArray((value as QueryLike).args);
}

export function render(query: unknown): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const value = (arg: unknown): string => {
    if (isQuery(arg)) return walk(arg);
    if (typeof arg === "object" && arg !== null && arg.constructor.name === "Identifier") return (arg as { value: string }).value;
    params.push(arg);
    return `$${params.length}`;
  };
  const walk = (q: QueryLike): string => {
    let out = q.strings[0] ?? "";
    for (let i = 1; i < q.strings.length; i++) out += value(q.args[i - 1]) + (q.strings[i] ?? "");
    return out;
  };
  if (!isQuery(query)) throw new Error("not a postgres.js query");
  return { text: walk(query), params };
}
