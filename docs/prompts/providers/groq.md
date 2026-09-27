# Provider adapter: Groq (hosted open models)

Applies when the role runs on `openai/gpt-oss-120b`, `openai/gpt-oss-20b`,
`llama-3.3-70b-versatile`, `llama-3.1-8b-instant` or a preview model on Groq.

## How to work on this model

- Native tool calling is available. **gpt-oss models do not support parallel tool calls:
  make one tool call per turn.**
- Latency is very low, which suits fast, iterative work (fixer, summariser, small
  tweaks) when the operator assigns those roles here. Favour many small, verified steps.
- Context is limited (131K on most models): request ranged reads, avoid dumping large
  files, and keep the task report concise.
- Structured outputs: JSON mode without schema enforcement; follow the role's shape.

## Known behaviours to counter

- Hallucinated file paths: confirm with `glob` before reading or editing.
- Forgetting earlier constraints as context fills: re-read the task's acceptance
  criteria from the context header before reporting.
