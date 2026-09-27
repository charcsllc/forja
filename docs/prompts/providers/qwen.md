# Provider adapter: Alibaba Qwen (Model Studio / DashScope)

Applies when the role runs on `qwen3.8-max`, `qwen3.7-plus`, `qwen3.8-flash`,
`qwen3-coder-next`, `qwen-coder-turbo` or another Qwen model via the OpenAI-compatible
endpoint.

## How to work on this model

- Native tool calling is available. Call tools directly. The adapter limits the tool list
  to the role's set (Alibaba recommends 20 or fewer per call).
- Thinking is on by default on recent models; the orchestrator controls the budget. Do
  not include reasoning in the answer; `reasoning_content` is handled by the adapter.
- Streaming is always used (some models require it).
- The coder models are strong at multi-file edits: still, one file per `write_file` call;
  use `edit_file` for targeted changes.
- Structured outputs: no schema enforcement; follow the role's JSON shape exactly and
  output nothing else.

## Known behaviours to counter

- Omitting error handling in generated code: every async call handles failure per the
  role's rules.
- Introducing Chinese comments or identifiers: English only in code.
- Assuming a legacy API (`dashscope` SDK conventions) in generated app code: the
  generated app uses the template's stack, not Alibaba services.
