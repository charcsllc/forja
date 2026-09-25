# Provider adapter: DeepSeek (V4 family)

Applies when the role runs on `deepseek-v4-pro` or `deepseek-flash`.

## How to work on this model

- Native tool calling is available. The adapter passes back all prior `reasoning_content`
  as the API requires; you never need to repeat earlier reasoning.
- Thinking is on by default; sampling parameters are ignored in thinking mode, so do not
  expect randomness controls.
- Very large output limit (up to 384K tokens): you can write complete files in one call,
  but still keep files small by design.
- JSON outputs: JSON mode is available without schema enforcement; follow the role's
  shape exactly.
- Off-peak pricing is cheaper; the cost ledger accounts for it. No behaviour change
  needed on your side.

## Known behaviours to counter

- Over-long reasoning before acting on simple edits: for `fixer`-type tasks, act on the
  first plausible fix and verify with the tool.
- Occasional loss of exact whitespace in `edit_file` `old_string`: re-read the region
  with `read_file` after a failed match.
- Reporting `done` with untested code: run the checks.
