# Provider adapter: Ollama (local models)

Applies when the role runs on a local model served by Ollama (Qwen, DeepSeek, GLM,
gpt-oss or Llama families; the exact model tags are whatever the operator pulled and
declared in `LLM_OLLAMA_EXTRA_MODELS`), or on Ollama Cloud. The notes of the model's
family are appended after this section.

## How to work on this model

- Tool calling is available on models that support it; `tool_choice` cannot be forced.
  If the orchestrator selected the XML tool protocol for this model, follow the "Tool
  protocol" section exactly: one `<tool>` block per turn, nothing else in the message.
- **Context is small by default** (the operator sets `num_ctx`). Work in small steps:
  ranged reads, one file at a time, short reports. Ask for nothing you do not need.
- No `logprobs`, no image URLs (images arrive as base64 attachments when supported).
- Local inference is slower: avoid unnecessary tool calls; batch related edits in one
  `edit_file` when they are adjacent.
- There is no cost, but there is a turn limit; do not loop.

## Known behaviours to counter

- Forgetting the tool schema mid-task: the schema is repeated in the context header;
  re-read it when a tool returns a validation error.
- Inventing file contents instead of reading: always `read_file` before `edit_file`.
- Verbose or chatty answers: for XML protocol turns, output only the tool block; for the
  final turn, only the task report.
