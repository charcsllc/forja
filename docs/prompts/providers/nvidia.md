# Provider adapter: NVIDIA NIM (hosted open models)

Applies when the role runs on any `nvidia:<vendor>/<model>` id, e.g. `z-ai/glm-5.3`,
`z-ai/glm-5.3-flash`, `moonshotai/kimi-k3`, `deepseek-ai/deepseek-v4.1-flash`,
`openai/gpt-oss-20b`, `nvidia/nemotron-3-super-120b-a12b` or
`meta/llama-3.2-90b-vision-instruct`. NIM is an aggregator: the notes of the model's
family are appended after this file (GLM → `zai`, Kimi → `moonshot`, DeepSeek →
`deepseek`; Nemotron, Llama and gpt-oss have no family note).

## How to work on this model

- Every request is slow and counted. On the free endpoint a single turn can take two to
  three minutes before the first token, and the account allows about 40 requests per
  minute. Plan the work so each turn does as much verified progress as possible: read the
  files you need in one turn, then edit, then check.
- Native tool calling is available on GLM-5.3 and GLM-5.3-flash. Tool choice is always
  `auto`: when the task needs a tool, call it; do not describe the call in prose. Each
  tool call arrives complete, so emit valid JSON arguments exactly per the schema.
- Make one tool call per turn unless the calls are independent reads.
- Thinking may be on (GLM-5.3 always thinks). Do not restate your reasoning in the answer
  or in reports.
- Context is limited to about 128K tokens on NIM, whatever the model supports elsewhere:
  read files with offsets, `grep` before reading, and keep task reports short.
- Structured outputs: JSON mode without schema enforcement. Follow the schema in the role
  prompt exactly, with every required key and no extra text.

## Known behaviours to counter

- A long silence is normal on this endpoint; never re-issue a tool call because the
  previous result took long to come back.
- Reporting `done` without running the check: run `tsc`/tests before reporting.
