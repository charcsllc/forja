/**
 * Orchestration settings from the environment (docs/architecture/09 "AGENT_*", 03 §6).
 *
 * What this protects: one parser with the documented defaults, so the retry policy is a
 * single table (03 §6) and a typo never silently changes a limit: invalid values fall back
 * to the default and are reported in `problems` (the engine logs them at boot).
 * Per-role model settings (`AGENT_<ROLE>_{MODEL,FALLBACKS,EFFORT,MAX_OUTPUT_TOKENS,
 * TOOL_PROTOCOL}`) belong to the LLM gateway (`gateway.roleSettings(role)`), not here.
 */

export interface AgentSettings {
  maxParallelTasks: number;
  maxTurnsPerTask: number;
  taskLocalRetries: number;
  fixerPasses: number;
  maxFixRounds: number;
  maxReviewRounds: number;
  contextSoftLimit: number;
  problems: string[];
}

export const AGENT_DEFAULTS = {
  maxParallelTasks: 1,
  maxTurnsPerTask: 60,
  taskLocalRetries: 2,
  fixerPasses: 3,
  maxFixRounds: 4,
  maxReviewRounds: 2,
  contextSoftLimit: 0.6,
} as const;

export function parseAgentSettings(env: Record<string, string | undefined>): AgentSettings {
  const problems: string[] = [];
  const int = (name: string, def: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name}=${raw} is not an integer in [${min}, ${max}]; using ${def}`);
      return def;
    }
    return n;
  };
  const fraction = (name: string, def: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0.1 || n >= 0.95) {
      problems.push(`${name}=${raw} must be between 0.1 and 0.95; using ${def}`);
      return def;
    }
    return n;
  };
  const maxParallelTasks = int("AGENT_MAX_PARALLEL_TASKS", AGENT_DEFAULTS.maxParallelTasks, 1, 16);
  if (maxParallelTasks > 1) problems.push("AGENT_MAX_PARALLEL_TASKS > 1 is a v2 feature; tasks run one after another");
  return {
    maxParallelTasks: 1,
    maxTurnsPerTask: int("AGENT_MAX_TURNS_PER_TASK", AGENT_DEFAULTS.maxTurnsPerTask, 3, 500),
    taskLocalRetries: int("AGENT_TASK_LOCAL_RETRIES", AGENT_DEFAULTS.taskLocalRetries, 0, 10),
    fixerPasses: int("AGENT_FIXER_PASSES", AGENT_DEFAULTS.fixerPasses, 1, 10),
    maxFixRounds: int("AGENT_MAX_FIX_ROUNDS", AGENT_DEFAULTS.maxFixRounds, 0, 20),
    maxReviewRounds: int("AGENT_MAX_REVIEW_ROUNDS", AGENT_DEFAULTS.maxReviewRounds, 0, 10),
    contextSoftLimit: fraction("AGENT_CONTEXT_SOFT_LIMIT", AGENT_DEFAULTS.contextSoftLimit),
    problems,
  };
}
