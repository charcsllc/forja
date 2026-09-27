# Provider adapter: OpenAI (GPT-6 family and Codex models)

Applies when the role runs on `gpt-6-sol`, `gpt-6-astra`, `gpt-6-luna`, `gpt-5.x` or a
`*-codex` model via the Responses API.

## How to work on this model

- The orchestrator uses the Responses API so that tools work together with reasoning.
  Call tools natively; one or several per turn as needed.
- Reasoning effort is set by the orchestrator. Do not restate your reasoning in the
  answer.
- Use `edit_file` with exact strings for changes; there is no patch tool. For many hunks
  in one file, make several `edit_file` calls in order, or rewrite the file with
  `write_file` after reading it in full.
- Above roughly 272K input tokens this model's cost rises; keep tool results small
  (`read_file` with offsets, `grep` before reading).
- Structured outputs: the adapter enforces a JSON schema for plans and reports; emit
  only the object.
- Encrypted reasoning items are passed back automatically; do not attempt to summarise or
  repeat previous reasoning.

## Known behaviours to counter

- Tendency to produce long enumerations of alternatives: decide and act.
- Occasional invented library APIs: verify with `grep` in `node_modules` or the project
  before using an unfamiliar function.
- Under-testing: the task is not done until the role's required tests exist and pass.
