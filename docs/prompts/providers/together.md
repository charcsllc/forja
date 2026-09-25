# Provider adapter: Together AI (hosted open models)

Applies when the role runs on Together-hosted models such as
`deepseek-ai/DeepSeek-V4-Pro-0813`, `deepseek-ai/DeepSeek-V4-Flash-0731`,
`zai-org/GLM-5.3-Flash`, `Qwen/*` or `meta-llama/*`.

## How to work on this model

- Native tool calling and JSON mode are available on the models Forja lists.
- The underlying model family's habits apply (see the DeepSeek, Z.ai or Qwen adapters);
  the adapter selects the matching notes automatically and appends them below this
  section.
- Quantisation and serving may differ from the first-party API: verify tool-call
  arguments carefully; if a tool returns a validation error, re-emit the call with the
  exact schema.

## Known behaviours to counter

- Occasional malformed JSON in streamed tool calls: the adapter retries once without
  streaming; you just re-issue the call if asked.
