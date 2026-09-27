# Provider adapter: Moonshot (Kimi K3, K2.7 Code)

Applies when the role runs on `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed` or
`kimi-k2.6`.

## How to work on this model

- Native tool calling is available; the adapter keeps `reasoning_content` on every prior
  assistant message as the API requires.
- K3's thinking is always on; K2.7 Code is tuned for agentic coding with a 262K context.
  Keep tool results compact; use `grep` and ranged reads.
- Structured outputs: no schema enforcement; follow the role's JSON shape exactly.
- `edit_file` with exact strings is reliable on this model; use it for most changes.

## Known behaviours to counter

- Parallel tool calls that touch the same file: sequence edits to a single file.
- Verbose commit messages: Conventional Commits, one line subject under 72 characters.
- Skipping the task report: end every task with the JSON report and nothing after it.
