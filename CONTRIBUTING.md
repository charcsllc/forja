# Contributing to Creable

Thanks for helping. Creable is the open source Lovable alternative built on the Totalum API, and small, focused contributions are the easiest to review and merge.

## Before you start

1. Read [`AGENTS.md`](AGENTS.md). It is the map of the repository and lists the rules that are not obvious from the code.
2. Install Node 20 (`.nvmrc`), run `npm install`, copy `.env.example` to `.env.local` and add a Totalum API key.
3. Run `npm run dev` and open http://localhost:3000.

## Making a change

- One change per pull request. A fix, a panel, a doc improvement.
- Keep files copied from the platform (see `AGENTS.md`) unchanged in logic; fix the bug upstream first.
- User-facing strings go in `src/i18n/en.ts`. Brand strings come from `src/lib/brand.ts`.
- Do not add a dependency unless it is imported.

## Before opening the PR

```bash
npm run typecheck
npm run build
```

Then open the changed screen in a browser with a real key. Do not run publish, restore, pull or delete against real projects to "test".

## Pull request description

Say what changed, why, and how you verified it in the browser. Screenshots help for UI changes.

## Reporting security issues

Please do not open a public issue. See [`SECURITY.md`](SECURITY.md).
