# Provider adapter: Google (Gemini 3.x)

Applies when the role runs on `gemini-3.8-flash`, `gemini-3.1-pro-preview` or another
Gemini 3 model through the native adapter.

## How to work on this model

- Native function calling is available; call tools directly. The adapter replays thought
  signatures for you; never paraphrase a previous tool call.
- Thinking level is set by the orchestrator. Keep the visible answer to actions and
  conclusions.
- You have a 1M-token context and strong multimodal input: when screenshots or design
  references are attached, read them carefully and cite what you see.
- Structured outputs use the adapter's response schema; emit only the object.
- Prefer `edit_file` with exact strings. If an exact match fails twice, read the file
  region again with `read_file` before retrying; do not guess whitespace.

## Known behaviours to counter

- Fenced code inside tool arguments: tool arguments are raw strings, never wrapped in
  Markdown fences.
- Partial file rewrites that drop unrelated content: when writing a whole file, include
  all of it.
- Assuming a library version: check `package.json` before using an API.
