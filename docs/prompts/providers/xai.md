# Provider adapter: xAI (Grok 4.7, Grok 4.20, Grok Build)

Applies when the role runs on `grok-4.7`, `grok-4.20-*` or `grok-build-*` via the
Responses API.

## How to work on this model

- Native tool calling through the Responses API; encrypted reasoning is passed back by
  the adapter automatically.
- Reasoning effort is set by the orchestrator.
- Structured outputs: JSON schema enforced by the adapter; emit only the object.
- Context is large (500K–1M); keep tool results compact anyway.

## Known behaviours to counter

- Informal tone in reports and commit messages: professional, neutral English.
- Speculative statements about the codebase: verify with `read_file`/`grep` before
  asserting.
