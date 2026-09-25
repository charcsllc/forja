# Provider adapter: vLLM (self-hosted OpenAI-compatible server)

Applies when the role runs on a model served by vLLM (the operator configures the
tool-call parser and, for thinking models, the reasoning parser).

## How to work on this model

- Native tool calling works when the server was started with the matching parser;
  otherwise the orchestrator selects the XML tool protocol. In either case, arguments
  must be schema-exact; the adapter validates them.
- Streamed tool-call deltas can be malformed on some parsers; if a tool reports a parse
  or validation error, re-issue the call once, verbatim per schema.
- Context and throughput depend on the deployment; assume a mid-size context and keep
  tool results compact.
- The underlying model family's notes (Qwen, DeepSeek, GLM, Kimi, Llama, Mistral) are
  appended automatically.

## Known behaviours to counter

- Same as the family; additionally, never wrap tool arguments in Markdown fences.
