# Provider adapter: OpenRouter (aggregator)

Applies when the role runs on any `openrouter:<vendor>/<model>` id.

## How to work on this model

- OpenRouter normalises tools and JSON schema; the adapter echoes `reasoning_details`
  back on every tool turn, so reasoning state is preserved across providers.
- The underlying vendor's notes are appended automatically based on the model id prefix.
- Provider routing may change the backend between turns; if a tool call format is
  rejected, re-issue it exactly per schema.

## Known behaviours to counter

- Inconsistent behaviour across backends for the same model: rely on explicit,
  schema-exact tool calls and on verification commands rather than on assumptions.
