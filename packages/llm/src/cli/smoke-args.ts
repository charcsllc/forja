/**
 * Argument parsing for `npm run llm:smoke` (kept apart from the CLI so tests never import
 * code that could send a request).
 *
 * What this file protects: the smoke test spends a real request, so it refuses to run
 * unless `--yes-spend-one-request` is given, and it accepts nothing it does not understand.
 */

export interface SmokeArgs {
  provider: string;
  model?: string;
  tools: boolean;
  envFile?: string;
}

export type SmokeArgsResult = { ok: true; args: SmokeArgs } | { ok: false; help: boolean; error?: string };

export const SMOKE_USAGE = `Usage: npm run llm:smoke -- --provider <id> [--model <id>] [--tools] [--env-file <path>] --yes-spend-one-request

Sends exactly ONE streamed request (max 256 output tokens) to the provider and prints the
route, latency, finish reason, usage and any tool call. No retries, no fallbacks.

  --provider <id>            LLM provider id (e.g. nvidia). A bare first argument also works.
  --model <id>               Model id from the catalog or LLM_<P>_EXTRA_MODELS (default: the
                             provider's first model; with --tools, its first native-tools model).
  --tools                    Offer a read_file tool and ask the model to call it.
  --env-file <path>          Load variables from a dotenv file first (e.g. infra/.env).
  --yes-spend-one-request    Required: confirms you accept spending one real request.`;

export function parseSmokeArgs(argv: string[]): SmokeArgsResult {
  let provider: string | undefined;
  let model: string | undefined;
  let envFile: string | undefined;
  let tools = false;
  let confirmed = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = (): string | undefined => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return undefined;
      i++;
      return next;
    };
    switch (flag) {
      case "--help":
      case "-h":
        return { ok: false, help: true };
      case "--provider": {
        const v = value();
        if (!v) return { ok: false, help: false, error: "--provider needs a value" };
        provider = v;
        break;
      }
      case "--model": {
        const v = value();
        if (!v) return { ok: false, help: false, error: "--model needs a value" };
        model = v;
        break;
      }
      case "--env-file": {
        const v = value();
        if (!v) return { ok: false, help: false, error: "--env-file needs a value" };
        envFile = v;
        break;
      }
      case "--tools":
        tools = true;
        break;
      case "--yes-spend-one-request":
        confirmed = true;
        break;
      default:
        if (!flag.startsWith("-") && provider === undefined) {
          provider = flag;
          break;
        }
        return { ok: false, help: false, error: `unknown argument ${arg}` };
    }
  }

  if (!provider) return { ok: false, help: false, error: "--provider is required" };
  if (!/^[a-z0-9-]+$/.test(provider)) return { ok: false, help: false, error: `invalid provider id ${provider}` };
  if (!confirmed) return { ok: false, help: false, error: "refusing to spend a real request without --yes-spend-one-request" };
  return { ok: true, args: { provider: provider.toLowerCase(), ...(model ? { model } : {}), tools, ...(envFile ? { envFile } : {}) } };
}
