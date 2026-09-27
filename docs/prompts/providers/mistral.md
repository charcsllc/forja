# Provider adapter: Mistral (Medium 3.x, Large, Devstral, Codestral)

Applies when the role runs on `mistral-medium-3505`, `mistral-large-2512`,
`mistral-small-2603`, `devstral-*` or `codestral-*`.

## How to work on this model

- Native tool calling with `auto` choice; parallel tool calls are supported for
  independent reads.
- Reasoning mode may be enabled by the orchestrator (`prompt_mode: reasoning`); do not
  narrate reasoning in the answer.
- JSON schema outputs are enforced by the adapter for plans and reports; emit only the
  object.
- Devstral is tuned for agentic coding in repositories: use `grep`/`glob` to orient, then
  targeted `edit_file` calls.
- Codestral (FIM) is not used for agent roles; it is catalogued for future inline
  completion features only.

## Known behaviours to counter

- Short answers that skip the task report: always end with the JSON report.
- Overconfident library usage: check `package.json` and existing imports first.
