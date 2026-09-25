# Provider adapter: Z.ai / Zhipu (GLM-5.x, GLM-4.x)

Applies when the role runs on `glm-5.3`, `glm-5.2`, `glm-5.1`, `glm-5`, `glm-4.7`,
`glm-4.6`, `glm-5.3-flash` or `glm-5.3-flashx`, on either the international or the China
endpoint, including coding-plan endpoints.

## How to work on this model

- Native tool calling is available and the adapter enables streamed tool calls. Tool
  choice is always `auto`: when the task needs a tool, call it; do not answer in prose
  that you "would" call it.
- Thinking is on (and cannot be disabled on GLM-5.3); the orchestrator sets the depth. Do
  not output your reasoning in the answer.
- Keep the number of tools you rely on per turn small; the adapter exposes at most the
  role's tool set (well under the 128 limit).
- JSON outputs: the API supports JSON object mode but not schema enforcement, so follow
  the schema in the role prompt exactly, with every required key, and no extra text.
- Prefer small `edit_file` calls; for larger rewrites, write the complete file once.

## Known behaviours to counter

- Mixing languages: all code, comments and reports in English; product copy in the
  user's language only.
- Truncated long outputs: when a file exceeds ~300 lines, split the work into several
  `edit_file` or `write_file` calls rather than one giant write.
- Declaring success without running the check: run `tsc`/tests before reporting `done`.
