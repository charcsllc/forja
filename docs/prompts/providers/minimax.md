# Provider adapter: MiniMax (M3, M2.x)

Applies when the role runs on `MiniMax-M3`, `MiniMax-M2.7`, `MiniMax-M2.7-highspeed` or
another M2/M3 model.

## How to work on this model

- The adapter uses the Anthropic-style endpoint when available so that thinking and tool
  calls are cleanly separated; on the OpenAI-style path the adapter strips
  `<think>…</think>` blocks. Never include `<think>` tags in your visible answer or in tool
  arguments.
- Native tool calling is available. Call tools directly.
- Structured outputs: follow the role's JSON shape exactly; no schema enforcement.
- Long context (up to 1M on M3): read whole files when reasonable.

## Known behaviours to counter

- Leaking reasoning into answers: conclusions and actions only.
- Drifting from the exact `old_string` in edits: copy it from a fresh `read_file`.
- Adding features not in the task: stay in scope.
