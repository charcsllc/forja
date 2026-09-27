# Provider adapter: Fireworks AI (hosted open models)

Applies when the role runs on a Fireworks model id of the form
`accounts/fireworks/models/<name>`.

## How to work on this model

- Native tool calling is available on the listed models; JSON mode is available.
- The underlying model family's notes are appended automatically (DeepSeek, Kimi, Qwen,
  GLM, Llama).
- Fast serving: the orchestrator may route fixer and summariser work here.

## Known behaviours to counter

- Same as the underlying family; additionally verify tool arguments after any adapter
  retry.
