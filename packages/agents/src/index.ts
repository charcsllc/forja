/**
 * @forja/agents: the agent runtime (phase 2).
 *
 * - `roles`: the phase-2 role definitions and `ROLE_REQUIREMENTS` for the LLM gateway.
 * - `tools`: the canonical registry (docs/architecture/11) and the ports the engine implements.
 * - `runtime`: the uniform agent loop, tool protocols, compaction.
 * - `prompts`: the system prompt assembler over the bundle generated from docs/prompts.
 * - `context`: the orchestrator's context headers.
 *
 * What this protects: no Docker, git or database dependency here; everything outside the
 * process goes through ports, so the whole runtime is unit-testable with fakes.
 */
export * from "./roles/index.js";
export * from "./settings.js";
export * from "./tools/types.js";
export * from "./tools/registry.js";
export { toJsonSchema, type JsonSchemaObject } from "./tools/json-schema.js";
export { LocalWorkspace, normalizeWorkspacePath, WALK_EXCLUDED_NAMES } from "./tools/local-workspace.js";
export { createRedactor, REDACTED, SECRET_PATTERNS } from "./tools/redact.js";
export { allowedByList, commandSegments } from "./tools/exec.js";
export * from "./runtime/loop.js";
export * from "./runtime/protocol.js";
export { createSummarizerCompactor, renderTranscript, type SummarizerDeps } from "./runtime/summarize.js";
export { estimateTokens } from "./runtime/tokens.js";
export * from "./prompts/assemble.js";
export { PROMPT_BUNDLE_HASH } from "./prompts/bundle.generated.js";
export * from "./context/task-context.js";
