# CLAUDE.md

All project guidance for AI coding agents lives in AGENTS.md (the cross-tool standard).
Claude Code imports it here so both files never drift:

@AGENTS.md

Claude Code specifics, on top of AGENTS.md:

- Start every task with AGENTS.md §0 and the matching row of §7. Do not re-derive the
  architecture; it is verified there.
- Read `node_modules/next/dist/docs/` before writing Next.js 16 code (proxy, fonts,
  route handlers). The framework differs from training data.
- Finish with `npm run typecheck` and `npm run build`; report their real output.
- Never run publish, restore, pull, import, export or delete against a real project to
  verify a change. Say what you could not verify instead.
- Keep AGENTS.md §11 (privacy) true: no analytics, no CDN-loaded scripts, no runtime-fetched
  fonts, Next telemetry disabled.
