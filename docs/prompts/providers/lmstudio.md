# Provider adapter: LM Studio (local models)

Applies when the role runs on a model served by LM Studio's OpenAI-compatible server.

## How to work on this model

- Tool calling and structured output are supported on capable models; when the
  orchestrator selects the XML tool protocol, follow it exactly (one `<tool>` block per
  turn, nothing else).
- Context length is whatever the operator loaded; assume it is limited. Small steps,
  ranged reads, concise reports.
- No cost; a turn limit applies. Do not loop on the same failing edit; re-read the file.

## Known behaviours to counter

- Same as Ollama: read before editing, output only the tool block or the report, re-read
  the tool schema on validation errors.
