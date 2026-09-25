# AGENTS.md — Forja

Forja is an open source (MIT) alternative to Lovable: a user types a prompt, an AI agent
builds a **full-stack Next.js app with its own database**, the user previews it live, edits
it visually or in code, and publishes it with one click. **This repository is only the
builder UI.** Everything heavy (coding agent, sandboxes, hosting, databases, deploys,
custom domains, GitHub sync, Figma import, logs) is done by the **Totalum API** behind one
API key. The UI is a thin, resellable client in front of that key.

This file is the map for AI coding agents and humans alike. `CLAUDE.md` imports it. Keep it
truthful: every path, constant and rule below was verified against the code on 2026-09-24.
When you change behaviour, change the matching line here in the same commit.

## 0. Read this first (30 seconds)

- **Product facts to keep honest.** Generated apps are server-rendered Next.js projects
  with an integrated database, auth, file storage, secrets, HTTPS hosting and custom
  domains. Never describe the output as a "React front end" or a "static site". This is
  why the README claims better SEO than Lovable's client-rendered default output.
- **Trademark.** "Lovable" is somebody else's mark. It names the category ("open source
  Lovable alternative"), never the product, the wordmark or the favicon. Product name,
  URLs and storage prefix come from `src/lib/brand.ts`.
- **No auth by design.** Every route is public and acts on one operator key. Anyone who can
  reach the URL spends that key's credits. The guards in `src/app/api/vcaas/_shared.ts` are
  deliberate no-ops. See §12 before putting this online.
- **Real key, real money.** `.env.local` holds a key that hits real projects. Click through
  the UI to verify, but never fire publish, restore, pull, import, export or delete against
  real projects "to test". Each of those costs credits and some are destructive.
- **No telemetry, ever.** The builder sends nothing to any third party at build time or run
  time except the Totalum API (and the URLs a user explicitly pastes: Figma, GitHub). §11
  lists what leaves the machine and how to prove it. Do not add analytics, error reporting,
  CDN-loaded scripts or fonts fetched at runtime.
- **API reference.** https://www.totalum.app/totalum-api.md is the whole core API in one
  Markdown file. Read it before touching `src/lib/vcaas*` or `src/app/api/`. Do not vendor a
  copy into this repo; link to it.
- **Sibling editions.** `totalumlabs/ai-app-builder-open` is the neutral white-label
  starter with the same engine. Logic fixes should be ported between the two. Theme, brand
  and copy may diverge; the API client, proxy routes and workspace behaviour should not.
- **Reselling.** The whole capability works multi-tenant, so an operator can add sign-up,
  login and billing and sell this under their brand, or embed it inside an existing SaaS.
  Link to https://www.totalum.app/whitelabel when writing about that. Steps in §12–§13.

## 1. Commands and verification

```bash
npm install                      # Node 20+ (.nvmrc); CI uses `npm ci`
cp .env.example .env.local       # then set TOTALUM_VCAAS_API_KEY=tlm_sk_...
npm run dev                      # http://localhost:3000
npm run typecheck                # tsc --noEmit: the fast correctness gate
npx tsc --noEmit --noUnusedLocals --noUnusedParameters   # import hygiene (advisory)
npm run build && npm start       # production build; run before any PR
npm audit                        # must stay at zero
```

- **There is no test suite.** Eleven files mention `src/lib/__tests__/…`; that directory
  does not exist. Verification = typecheck + build + open the changed screen in a browser
  with a real key.
- **CI** (`.github/workflows/typecheck.yml`) runs `npx tsc --noEmit` on pushes to `main`
  and on every pull request. Nothing else: no lint, no build, no tests.
- **ESLint is mostly off.** `eslint.config.mjs` disables about 30 rules (unused vars, `any`,
  exhaustive deps, `jsx-key`…) and there is no `lint` script. Do not rely on it.
- **TypeScript is not strict.** `tsconfig.json` has `strict: false`, so `null` and
  `undefined` are not checked. Narrow explicitly; do not assume the compiler caught it.
- **Local test key.** Maintainers keep this repo next to `ai-app-builder-open` and share
  one test key: `cp ../ai-app-builder-open/.env.local ./.env.local`. `.env.local` is
  gitignored. Never paste a `tlm_sk_` value into a tracked file, an issue or a PR.
- **Offline builds work.** Fonts are self-hosted (§11), so `npm run build` needs no
  network beyond the npm registry at install time.

## 2. How to work here

**Reading order for a task.** (1) this file; (2) the "Feature → where it lives" row in §7;
(3) the file's header comment, which in this codebase usually states the invariant the file
protects (look for `⭐` and `⚠️` markers, there are ~1,300 of them, all deliberate);
(4) the API reference for the endpoint involved.

**Definition of done.**
1. `npm run typecheck` passes and `npm run build` passes.
2. The changed screen was opened in a browser with a real key (say so in the PR).
3. No paid or destructive operation was triggered to "test".
4. User-visible change → one line in `CHANGELOG.md` under `Unreleased`.
5. A rule or path in this file changed → this file updated in the same commit.
6. No new dependency unless it is imported and `npm audit` is still zero.

**Commits.** Small and single-purpose, Conventional-Commits style, imperative, lowercase
subject: `fix(workspace): reload the preview after a publish`, `docs(brand): explain the
tagline field`, `ci: move to checkout@v5`. Scopes in use: `workspace`, `home`, `theme`,
`brand`, `proxy`, `config`, `env`, `changelog`, `ci`, `a11y`, and the lib file name for
`docs(...)`. Do not commit `.env*`, `next-env.d.ts` or the `# This is NOT the Next.js you
know` block that `next dev` re-adds at the bottom of this file.

**Next.js 16 is not the Next.js you remember.** Middleware is now `src/proxy.ts` exporting
`proxy`. Read the relevant guide under `node_modules/next/dist/docs/` before writing
framework code and heed deprecation notices.

**When the docs and the code disagree, the code wins.** Fix the doc. §10 lists comments
that already point at code that does not exist here; do not "restore" that code.

## 3. Architecture in one screen

```
browser ── vcaasApi (src/lib/vcaas.ts: one function per endpoint, no secrets, no process.env)
   │  same-origin fetch to /api/…
   ▼
src/app/api/vcaas/[...path]        JSON catch-all ─┐
src/app/api/vcaas/upload/[id]      multipart       │  add `api-key` ── src/lib/vcaas-server.ts
src/app/api/vcaas/source-code/[id] zip download    │                   (only reader of the key)
src/app/api/vcaas/git-diff         fetch a patch   │
src/app/api/preview/[id]/[[...p]]  same-origin dev-server proxy (visual editor only)
src/app/api/visual-edit/[id]/apply visual change → source edit → rebuild
src/app/api/config                 { configured: boolean }, never the key
   │
   ▼
https://api-accounts.totalum.app/api/v1/vcaas   ← documented at totalum.app/totalum-api.md
```

`src/proxy.ts` wraps every request with CORS and `Content-Security-Policy: frame-ancestors *`
(the builder may be framed by anyone). `next.config.ts` adds only no-cache headers,
`devIndicators: false` and `allowedDevOrigins: ["*"]`. `src/app/layout.tsx` forces
`dynamic = "force-dynamic"` and `revalidate = 0`; the comment above them says never to edit
those two lines.

### Lifecycle of one prompt

1. Home `src/app/page.tsx`: Enter → name dialog → `projects.launch({projectId, prompt,
   description, figma?})`. **With attachments** the path is different: `projects.create` →
   `figma.connect` (if a token is held) → `uploadFilesToProjectDetailed` → stash prompt and
   file list in `sessionStorage` → navigate; the workspace sends the first prompt itself.
2. Always navigate to `data.projectId` from the response, never to the slug you asked for;
   the API may pick another id and says so in `warnings`.
3. Workspace `src/app/project/[projectId]/page.tsx` polls `agent/status` every 10 s until
   `done` or `idle` (3 s re-polls while it waits for the run to leave `init`), then refetches
   the project and the conversation and bumps `previewKey`.
4. Preview URL rule: read the field named by `developmentUrlFieldToUse`, default
   `temporalDevelopmentProjectUrl`. It is a **field name**, not a URL. Never cache it.
5. Follow-ups: `agent/start` with optional run options (`model`, `effort`, `fastMode`).
6. Publish: `deployments/deploy` → `operation.begin("publish")` → poll `deployments/status`
   every 10 s (no cap) → on `success` or `error` wait for the preview to stop being a
   placeholder (3 s × 40) → `PublishedModal`.

## 4. Directory map

```
src/app/                 App Router shell: layout, error, global-error, not-found, globals.css, icon.svg
  page.tsx               Home: hero prompt, name dialog, gallery (client-side search/sort/paging)
  [...slug]/             Catch-all → redirect("/")
  project/[projectId]/   The workspace page (~1,750 lines): polling, operation slot, modals, wake, visual editor
  api/                   Route handlers (see §3 and §5)
src/components/
  brand/Logo.tsx         Mark (two gradient rounded squares) + wordmark from BRAND.name
  workspace/             Panels and modals; db/ (CMS), visual-editor/, use-*.ts hooks
  prompt/                Figma and GitHub composer buttons
  primitives/            Modal, ConfirmDialog, ErrorState, Skeletons… (copied from the platform)
  plan/                  No-op shims (PaidFeature renders children; CapabilityUsage returns null)
  ui/                    shadcn/Radix wrappers; about half are unused (see §10)
  common/                Empty (.gitkeep)
  SetupBanners.tsx       "Add your Totalum API key" card, home only, when /api/config says unconfigured
  GlobalErrorCatcher.tsx Swallows window error/unhandledrejection to hide the Next overlay; logs nothing
src/i18n/                English-only useT() over en.ts (5,185 lines, ~277 KB, platform copy)
src/lib/                 vcaas*.ts (client/server/types/errors), safe-url, preview-proxy/-health,
                         visual-edit*.ts (server-side engine), project-*, upload, attachments, db helpers, brand
src/proxy.ts             CORS + CSP for every request
```

## 5. Server routes

| Route | Methods | Guards | `publicUrlRejectionReason` | Limits / notes |
|---|---|---|---|---|
| `/api/config` | GET | no | no | `{configured}` from key length; key never returned |
| `/api/vcaas/[...path]` | GET POST PUT DELETE PATCH | no | no | No timeout, size or rate limit. Non-JSON upstream body → 500 `UNKNOWN`. Drops upstream headers, so `meta` (X-Total-Count) is never filled |
| `/api/vcaas/upload/[projectId]` | POST | no | no | **No size check here**; the API is the authority. 413 → `FILE_TOO_LARGE`; `retryable` = 5xx or 429; `code` is the raw upstream code |
| `/api/vcaas/source-code/[projectId]` | GET | no | no (URL comes from upstream) | Fetches the signed archive with `redirect:"error"` and a 60 s timeout, buffers the whole zip; ignores the `?intent=` the client sends |
| `/api/vcaas/git-diff` | GET | no | **yes** | https-only host allowlist (`totalum.app`, `totalum-project.com`, `webapp-project.com`, `storage.googleapis.com`), `redirect:"error"`, 20 s, 10 MB |
| `/api/preview/[projectId]/[[...path]]` | GET POST PUT PATCH DELETE HEAD | yes | no | Serves the visual-editor agent at `__totalum-visual-editor.js`; rewrites HTML/CSS/redirects to stay same-origin; strips cookies, CSP, HSTS; origin cached 15 s keyed by caller+project |
| `/api/visual-edit/[projectId]/apply` | POST | yes | **yes** (uploaded assets) | ≤100 changes, ≤200 source files, ≤12 MB per asset, 20 s asset fetch; resolves everything before writing anything; write-fidelity canary once per process |

**`src/lib/vcaas-server.ts`.** `VCAAS_BASE_URL = https://api-accounts.totalum.app/api/v1/vcaas`.
`resolveVcaasUrl` refuses a path that does not start with `/`, contains `%2e`/`%2f`/`%5c`
before the `?`, resolves to another origin, or resolves outside `/api/v1/vcaas/`. It checks
the **resolved** URL, i.e. what `fetch` will request. `getVcaasApiKey()` reads
`TOTALUM_VCAAS_API_KEY` with a legacy fallback to `VCAAS_API_KEY`. `vcaasRequest` sets
`api-key` and JSON content-type and ignores a `_ctx` argument so routes copied from the
platform compile; `vcaasUploadRequest` sets only `api-key` so fetch can write the multipart
boundary. The module is **not** protected by `import "server-only"` (the package is not
installed); the header comment is the only guard. Never import it from a client component.

**Envelope.** Success `{ok:true, data}`. Failure `{ok:false, error, code, upstreamCode,
details, data:null}` where `code` is the stable union in `src/lib/vcaas-errors.ts`
(`INSUFFICIENT_CREDITS`, `PLAN_REQUIRED`, `PROJECT_LIMIT_REACHED`, `PROJECT_NOT_FOUND`,
`RATE_LIMITED`, `VALIDATION`, `UPLOAD_QUOTA_EXCEEDED`, `UNKNOWN`) and `upstreamCode` is
Totalum's own name. Two codes the UI reacts to specially:
- `INSUFFICIENT_CREDITS` → `proxyRequest` dispatches the window event
  `totalum:insufficient-credits`; `InsufficientCreditsModal` (mounted once in `layout.tsx`)
  opens and links to `BRAND.billingUrl`. The response still reaches the caller.
- `SERVER_NOT_READY` (upstream 409, sandbox asleep) is **not** in the union: it arrives as
  `code:"UNKNOWN"` with `upstreamCode:"SERVER_NOT_READY"`. Match it with
  `upstreamCode ?? code` (see `use-server-wake.ts`), never on `code` alone.
- `PROJECT_NOT_FOUND` also means "not yours". Do not add a distinct FORBIDDEN code.

**Guards** (`_shared.ts`): `resolveVcaasContext()` always returns `{ok:true, ctx:{}, team:{}}`
and `enforceProjectScope()` always returns `null`. Only the preview and visual-edit routes
call them today. This is the file to make real before users log in (§12).

## 6. Client catalog (`src/lib/vcaas.ts`)

Every UI call goes through `vcaasApi`. Never hardcode an `/api/vcaas/...` path in a
component (one legacy offender: `components/workspace/db/FileField.tsx` uploads with a raw
`/api/vcaas/upload/...` URL; fix it by routing through `vcaasApi.upload` when you touch it).
Namespaces and upstream paths (`P` = `/projects/{id}`):

| Namespace | Functions → upstream |
|---|---|
| `projects` | `list` GET `/projects` (limit, skip, search, sort, group, dates) · `get` · `create` · `launch` POST `/projects/launch` · `update` PATCH (send only changed fields, `null` clears) · `remove` · `exportProject` (2 credits, 1/min, 5/h) · `importProject` (6 credits, destructive, async) |
| `agent` | `status` · `fullConversation` · `start` · `stop` · `restartServer` POST `P/agent/server/start-or-restart` |
| `deployments` | `status` (null when never published) · `deploy` |
| `github` | `status` · `pullStatus` · `connect` · `disconnect` · `pull` · `env` |
| `figma` | `status[?verify]` · `connect` · `disconnect` · `validate` POST `/figma/validate` (no project; rate-limited) |
| `database` | `tablesStructure` · `query` POST `P/database/query` · `createRecord` · `updateRecord` · `deleteRecord` · `linkRecord` / `unlinkRecord` (many-to-many only; unlink is DELETE with a body) |
| `secrets` | `create` · `remove` (values are write-only) |
| `domain` | `set` PUT · `remove` |
| `versions` | `list` · `recover` (restore) · `diff` GET `P/version-diff?commitSha=` |
| `projectGroups` | CRUD on `/project-groups` (unused by this UI) |
| `files` | `tree` (free) · `content` (free) · `write` PUT, **always base64** (1 credit; not live until rebuild) |
| `rebuild` | `start` (1 credit, 1–4 min) · `status` |
| `logs` | `dev` · `prod` (always send `from`, or the worker returns only the last 6 h) |
| `webhooks` | `list` · `register` · `remove` (account-scoped; one per event) |
| top level | `gitDiff(url)` · `sourceCode(id, intent)` (raw fetch, returns `Response`) · `upload(id, formData)` (raw fetch) |

`sourceCode` and `upload` bypass `proxyRequest`, so they never fire the credits event.
`files.write` base64-encodes because the upstream sanitize-html middleware strips
`className` from plain strings. Do not "simplify" that.

**Adding an endpoint:** typed function in `vcaas.ts` → type in `vcaas-types.ts` → let the
catch-all carry it. Add a dedicated route under `src/app/api/vcaas/` only when the request
or response is not plain JSON.

## 7. Feature → where it lives

| Feature | Entry point | Verified notes |
|---|---|---|
| Home, hero, gallery | `src/app/page.tsx` | Gallery = one `projects.list()`, sorted client-side, 20 per page; table view by default above 20 projects. "New" focuses the textarea; there is no empty-project form. Slug rules: 3–35 chars, lowercase, hyphens. |
| Figma in the hero | `page.tsx` + `FigmaModal` without `projectId` | Token validated by `figma.validate`, held in memory, sent as `figma.token` on `launch` (no attachments) or via `figma.connect` after `create` (with attachments), then dropped. |
| Workspace shell | `src/app/project/[projectId]/page.tsx` | Owns polling, the operation slot, wake, all modals, the visual editor toggle, the composer text and attachments. |
| Chat + composer tray | `components/workspace/ChatPanel.tsx` | Tray order: attach · Figma · GitHub · run options · pencil (desktop only). Run options (`model` opus\|sonnet, `effort` low…xhigh, `fastMode` opus only) live in `sessionStorage` `tp_run_options:<id>` (per project, per tab) via `useRunOptions` in `RunOptionsMenu.tsx`, and are sent only when non-default. |
| Stopping a run | `ChatPanel.tsx` → `ConfirmDialog tone="danger"` | Confirms first, no typed phrase. The run is paid for and cannot be resumed. |
| Attachments | `AttachmentPreview.tsx`, `lib/attachments.ts`, `lib/composer-attachments.ts` | ⌘/Ctrl+V attaches clipboard files unless the clipboard is really text. Previews confirmed with `img.decode()`, never `onError` (React 19). Workspace attachments are page state persisted per project (`totalum:attachments:project:<id>`, 7 days, 20 files); the hero's are raw `File`s and are not persisted. `decodeAttachments` lives in the page. |
| Upload limits | `lib/upload.ts` | `MAX_UPLOAD_BYTES` = 8 MB, checked in the browser (`splitBySize`); 3 attempts, 1.5 s apart, none after `retryable:false`. Our upload route forwards without checking; the API is the authority. `lib/attachments.ts` has an unused 12 MB constant and mentions a 25 MB proxy guard that does not exist. |
| Preview + address bar | `PreviewPanel.tsx`, `PathPicker.tsx`, `lib/project-routes.ts` | Address bar lists the project's own App Router pages from `files.tree` (free, limit 5000), loaded on focus. `peekArchive` in `lib/source-archive-cache.ts` always returns `null` by design. Phone frame is 375×667. The direct sandbox URL is used for viewing; the same-origin proxy only while the visual editor is open. |
| Waking a sleeping server | page (`markWorkspaceTouched`, `autoStartedFor`, `hasNoLiveServer`) | Auto-start fires once per project per mount when the user **touches** the workspace (root `onClickCapture`; clicks inside `[data-workspace-header]` do not count), the server is `Archived` (or has no status and a cached URL), nothing is running, and there is at least one user message. Refused actions **claim** the wake instead of erroring: composer send (prompt and files go back in the box), publish, pull, restore (throws so the dialog stays open), code save and rebuild, GitHub modal, diff viewer. |
| Wake / blocked UI | `use-server-wake.ts`, `ServerWakeNotice`, `ServerBlockedDialog` | Poll 5 s, timeout 10 min, estimate 4 min, persisted in `totalum:server-wake:<id>`. Blocked answers travel over the window event `totalum:server-wake-blocked`. The notice is a strip rendered by the page, not a dialog, and never promises to replay the action. `PreviewPanel` only shows a "cached snapshot" badge. |
| Code editor | `CodePanel.tsx`, `workspace/monaco/`, `lib/monaco-diagnostics.ts` | Monaco is **self-hosted** (bundled `monaco-editor` 0.56, `loader.config({monaco})`, local worker wrappers); never let it fall back to the jsDelivr CDN (§11). `monaco-diagnostics.ts` reads `api.typescript ?? api.languages?.typescript` because 0.55 moved the language namespaces to the top level (local deviation from the platform copy). Source = `sourceCode` zip unzipped with fflate, cached 3 min in `localStorage` `<prefix>-code-<id>`. ⌘S → `files.write` (base64) → `rebuildNeeded`; **rebuild is a separate manual button** (`rebuild.start`, then `rebuild.status` every 8 s × 40). Markers are all silenced in `beforeMount`. |
| Database CMS | `DatabasePanel.tsx`, `components/workspace/db/*`, `lib/{totalum-schema,totalum-query,db-cell,db-files,join-filter}.ts` | Querying is server-side, always: paging (25/50/100), sorting, search (350 ms debounce) and filters compile into `queryOptions` (`_limit`, `_offset`, `_sort`, `_filter`, `_count`). Writing a file field sends `{name}` only; never build file URLs by hand. A refused expansion must not take the table down. |
| Visual editor | `components/workspace/visual-editor/*`, `lib/visual-edit*.ts` | Desktop only (only the desktop `ChatPanel` gets the pencil, only the desktop `PreviewPanel` gets `frameRef`). Blocked while a run or operation is active ("busy" toast) or until the live server is ready ("starting" dialog). postMessage types `totalum:ve:*`, always with an explicit origin, never `"*"`, source-checked. Apply → `phase` idle/applying/rebuilding/done/error; the page drives `rebuilding` (6 s polls, 10 min cap, then HEAD-probes the proxy). Closing the panel discards the batch. |
| Versions, Secrets, Domain, GitHub, Figma | `*Modal.tsx` | Errands, not tabs. `openModal: "versions" \| "secrets" \| "domain" \| "github" \| "figma" \| null`. Logs, Clone, Diff and Published use their own flags, so Diff can sit over Versions on purpose. Secrets/Domain/GitHub/Figma use `useDirtyGuard`; never pair it with `dismissible={false}`. Domain polls `projects.get` every 20 s while open. |
| Logs | `LogsPanel.tsx` inside `primitives/Modal size="xl" flush` | Auto-refresh off by default (10 s dev, 30 s prod), search debounced 500 ms. |
| Publish | `DeployControl.tsx` → page `handleDeploy` → `PublishedModal.tsx` | Pre-publish dialog explains public URL, ~3 min, 1 credit. `SANDBOX_NOT_REACHABLE` opens `ServerBlockedDialog`. Success injects an agent message with the `<id>.totalum-project.com` URL and links to the domain modal. |
| Long operations | `use-project-operation.ts`, `OperationBanner.tsx`, `lib/project-operation.ts` | Kinds: `publish`, `rebuild`, `githubPull`, `restartServer`, `restoreVersion`, `import`. One slot per project, persisted in `localStorage` `totalum:project-op:<id>` with `timeoutMs` (8–30 min; import = 30 min because upstream's is) and 60 s clock-skew grace. The page's watcher polls every 8 s for at most 60 attempts; publish is watched by the deploy poll instead. Banner has no cancel and can never be permanent. |
| Export / import / duplicate | `ProjectTransferDialogs.tsx`, `lib/project-transfer.ts` | Import is destructive, async and rate-limited upstream (1/min, 5/h); no auto-retry. The dialog writes the `import` slot directly (`writeOperation`) before navigating; `ImportOverlay` sits above every modal. |
| Diff viewer | `DiffViewer.tsx`, `lib/diff-parse.ts` | Tries the stored patch via `/api/vcaas/git-diff` first, then `versions.diff(commitSha)`. Has its own `useServerWake`. |
| Insufficient credits | `InsufficientCreditsModal.tsx` (mounted in `layout.tsx`) | Listens for `totalum:insufficient-credits`; links to the operator's billing page (`BRAND.billingUrl`). Change that link before selling to customers. |
| Setup | `SetupBanners.tsx`, `/api/config` | Shown on the home page when no key is configured. |

## 8. Workspace state model

- **Layouts.** Desktop (`hidden sm:flex`) and mobile (`flex sm:hidden`) are both in the
  DOM. Desktop `ChatPanel` is always mounted; mobile `ChatPanel` mounts only when
  `mobileTab === "chat"`. Anything the composer *holds* (prompt, attachments) is page
  state passed down, so switching layouts loses nothing. `runOptions` is the known
  exception: it is read from `sessionStorage` per panel instance.
- **Polling cadences** (all in the page unless noted):

  | What | Interval | Stop |
  |---|---|---|
  | `agent/status` | 10 s (3 s while leaving `init`, max 4) | `done` / `idle` |
  | `deployments/status` | 10 s | `success` / `error` (no cap) |
  | Operation watcher | 8 s | kind-specific condition or 60 attempts |
  | Visual-edit rebuild | 6 s | `success`/`error`/3× `idle`, 10 min cap |
  | Wake (`use-server-wake`) | 5 s | server Active and not cached, 10 min cap |
  | Post-publish preview probe | 3 s | not a placeholder, 40 attempts |
  | Stale tab | on focus/visibility/pointerdown | re-read if last read > 5 min and nothing active |
  | Domain modal | 20 s | modal closed |

- **First build.** `isFirstBuild` hides the preview during the first run. `liveReady` =
  `Active` and `developmentUrlFieldToUse === "temporalDevelopmentProjectUrl"` and a URL exists.
- **Dead state.** `darkMode` in the workspace page is never set; there is no theme toggle
  and no `ThemeProvider` (`next-themes` is used only by `ui/sonner.tsx`).

## 9. Browser storage keys

| Key | Store | Owner |
|---|---|---|
| `forja:dashboard-view` | local | `app/page.tsx` |
| `forja:pendingPrompt:<id>`, `forja:pendingFiles:<id>` | session | home → workspace hand-off |
| `forja-code-<id>` | local | `CodePanel.tsx` (3 min TTL) |
| `totalum:project-op:<id>` | local | `lib/project-operation.ts` |
| `totalum:server-wake:<id>` | local | `use-server-wake.ts` |
| `totalum:attachments:project:<id>` | local | `lib/composer-attachments.ts` |
| `totalum:run-expected:<id>`, `totalum:run-start:<id>` | local | run progress |
| `totalum:database:page-size`, `totalum:database:table-sort` | local | `DatabasePanel.tsx` |
| `tp_run_options:<id>` | session | `RunOptionsMenu.tsx` |

`STORAGE_PREFIX` (`forja`) is used only by keys written for this edition. The `totalum:*`
and `tp_*` keys come verbatim from the platform files and are kept so those files can be
re-copied. Rule: **new keys use `STORAGE_PREFIX`; do not rename the platform keys.** The
window events `totalum:insufficient-credits` and `totalum:server-wake-blocked` and the
postMessage types `totalum:ve:*` are protocol names, not brand strings; leave them.

## 10. Rules that are not obvious from the code

**Security and the key**
1. Every upstream URL must stay inside `/api/v1/vcaas/`; build it only through
   `resolveVcaasUrl`. Check the resolved URL, not the string you assembled.
2. Any server route that fetches a **client-supplied URL** must call the async
   `publicUrlRejectionReason` (resolves DNS; blocks every private range, the metadata IP,
   IPv4-mapped IPv6, NAT64, `*.local`/`*.internal`), and fetch with `redirect: "error"`
   and a timeout. A host allowlist alone is not enough (redirect bounce to 169.254.169.254).
   Today only `git-diff` and `visual-edit/apply` do this. If the upload route ever accepts a
   URL, add it there too.
3. The preview proxy strips `set-cookie` and caches the resolved origin keyed by
   **caller + project**; both are security properties. It is for editing, not viewing.
4. `vcaas.ts` and `vcaas-errors.ts` are shared by both runtimes: no `process.env`, no
   `crypto`, no `node:*`, no import of `vcaas-server`.
5. The key is never exposed via `NEXT_PUBLIC_*`, never logged, never returned by `/api/config`.

**Upstream contracts**
6. Agent runs, deploys, rebuilds, imports and restores are **async**. Poll; never assume
   completion from the start response. Do not believe `deployments/status` right after a
   deploy: it may still describe the previous publish.
7. File content is always sent base64 (`files.write`, visual-edit writes). Do not patch the
   upstream sanitizer either.
8. Visual-edit writes nothing until every change is resolved; the fidelity canary runs once
   per process because each write costs a credit.
9. `developmentUrlFieldToUse` is a field name; `productionProjectUrl` is a hostname.
10. `isRoutableProjectSlug` to read, `isValidProjectSlug` to create.
11. Export/import/publish/rebuild/write cost credits (see §6). Do not retry a refusal.

**Client state and UX**
12. Long operations belong to the **page**, not the modal or popover that started them.
    `operation.begin(kind)`; the page's bounded watcher ends it. Long-lived closures read
    `operation.current()`, never a stale value.
13. After every finished prompt, refetch the project and re-derive the preview URL.
14. Restore in an effect, never during render. Persisted stamps are parsed with expiry.
15. `preview-health.ts`: a false positive ("your app is dead") is worse than a false
    negative. Do not reintroduce "Archived ⇒ dead".
16. `CodePanel`: update the local copy only after the write is accepted; saved is not live.
17. Copy rules: no API vocabulary in the wake strip; "label" is never a "rename"; do not
    add GitHub permission names; the MCP copy at `en.ts:1654` is deliberate.

**Files copied from the platform**
18. Most of `components/workspace/*`, `components/prompt/*`, `components/primitives/*`,
    `lib/{format,logs,domain-status,env-parse,diff-parse,github-repo}.ts` and `i18n/en.ts`
    came from totalum-platform via `ai-app-builder-open`. Keep their **logic** verbatim;
    fix bugs upstream first, then re-copy. `AttachmentPreview.tsx` is a deliberate local
    fork (per-kind plates) and says so in its header.
19. Styling for this edition goes through theme tokens and `brand.ts`, so a re-copy does
    not undo it.
20. `en.ts` is a straight copy of the platform dictionary (it still contains
    `brand.name: "Totalum"`, unused, and ~150 "Totalum" mentions in copy about the API).
    Never re-copy it wholesale. Add new keys individually, and tag each line added here
    with a trailing `// forja` comment so a diff against the platform shows them.

**Brand and theme**
21. Product name, tagline, meta title/description, repo/docs/API/billing URLs and
    `STORAGE_PREFIX` live in `src/lib/brand.ts`. No literal product name anywhere else.
    Rebrand = `brand.ts` + `src/app/icon.svg` + `components/brand/Logo.tsx` + README +
    `package.json` + the demo GIF.
22. Theme (`src/app/globals.css`, Tailwind 4, `@theme inline`, no `tailwind.config`):
    warm off-white surfaces (`--surface-*`), near-black ink ramp (`--ink` … `--ink-4`),
    `--radius: 0.75rem`, soft shadows. **Primary buttons are near-black** (`--primary`);
    the **brand accent is blue** (`--brand`) and the mark carries a blue→pink→orange
    gradient. Dark tokens exist under `.dark` for parity, but the UI ships light-only, as
    Lovable does. Fonts: Geist and Geist Mono, self-hosted (§11).
23. Layout conventions kept on purpose: home = centered prompt box, suggestion row, gallery
    below; workspace = chat column left (440 px, resizable 280–600), panel right, header
    with project name, **Preview / Database / Code** toggle, address bar and Publish.
    Do not "modernise" the look toward a generic dark SaaS theme.

**Known debt: do not be surprised, do not "restore"**
- Comments reference things that do not exist here: `readPageMeta`, `windowConversation`,
  `<CreditsProvider>`, `project-sort.ts`, `project-date-filter.ts`, `GATED_ROUTES`,
  `@/lib/plan`, `first-run.ts`, `support.ts`, `src/lib/__tests__/*`, a 25 MB upload proxy
  guard, and "the upload route uses safe-url". They describe the platform, not this repo.
- `source-code` route ignores `?intent=`; the paid-download rule in `vcaas.ts` comments is
  not enforced here.
- The catch-all drops upstream headers, so `meta.total` is never set.
- `next`, `tailwindcss` and `typescript` are devDependencies but are needed to build, and
  `typescript` is imported at runtime by `lib/visual-edit-source.ts` (server only, ~10 MB;
  never import the visual-edit engine from a client component). Do not install with
  `--omit=dev`.
- Unused: `ts-node`; `cmdk`, `react-hook-form`, `react-day-picker` and 15 `@radix-ui/*`
  packages are imported only by unused files in `components/ui/` (`alert`, `card`, `sheet`,
  `table`, `calendar`, `command`, `form`, `menubar`, `navigation-menu`, …). Removing a
  dependency means deleting its `ui` wrapper too, since `tsc` still compiles it.
- `check-types-errors` is a `--skipLibCheck` variant of `typecheck`; `test:serve` is
  just `next start -p 3000`.
- `components.json` (shadcn) points at `@/hooks`, which does not exist.
- `public/_headers` is a Cloudflare static-asset header file; there is no wrangler config.

## 11. Privacy: what leaves the machine

Audited on 2026-09-24 against the installed Next 16.3.4 source. The builder ships **no
analytics, error-reporting or tracking SDK**: no `<Script>` tags, pixels, `sendBeacon`,
`instrumentation*.ts`, `reportWebVitals` or CSP `report-uri`. Monaco's own
`StandaloneTelemetryService` is a no-op. What does cross the wire:

**Server side (this app's Node process)**
- `api-accounts.totalum.app/api/v1/vcaas` with the `api-key` header, method, path, query
  and body. No client headers are forwarded, no User-Agent override, no user or machine
  info.
- Signed URLs the API returns: the source archive (`source-code` route, `redirect:"error"`,
  60 s timeout) and stored patches (`git-diff`, https allowlist + SSRF guard). These live on
  Totalum's storage, which is Google Cloud Storage (`storage.googleapis.com`) or
  `*.totalum-project.com` / `*.webapp-project.com` / `*.totalum.app`.
- The project's sandbox origin, through the preview proxy while the visual editor is open.
  The proxy strips cookies, origin and referer; `x-forwarded-*` headers still reach the
  sandbox (known, low, left as is because generated apps may read `x-forwarded-host`).
- User-supplied media URLs in the visual editor, SSRF-guarded (§10 rule 2).

**Browser side**
- Same-origin pages and `/_next/static` only. **Monaco is bundled** from the
  `monaco-editor` package (`src/components/workspace/monaco/`, `loader.config({ monaco })`
  and local worker wrappers); it must never fall back to the jsDelivr default of
  `@monaco-editor/loader`. **Fonts are self-hosted** with `next/font/local` from
  `src/app/fonts/` (Geist and Geist Mono variable, OFL 1.1, the same files Next ships for
  its devtools). Builds work offline. Worker wrappers import `monaco-editor/editor/…` and
  `monaco-editor/language/…` (the package `exports` map; `monaco-editor/esm/vs/…` does not
  resolve).
- The project's dev URL in the preview iframe, and signed storage URLs for thumbnails,
  attachments and database files (Google Cloud Storage). Whatever the *generated* app
  loads is the generated app's business, not ours.
- The Figma account avatar (`FigmaModal.tsx`) loads from Figma's CDN only after the user
  connects a Figma account.

**Tooling**
- **Next.js telemetry is disabled** by `process.env.NEXT_TELEMETRY_DISABLED = "1"` at the
  top of `next.config.ts`. Next evaluates the config before it constructs `Telemetry`, so
  this covers `next dev` and `next build` on every OS without a dependency; `next start`
  never sends telemetry. `.env.example` and the CI workflow repeat the variable for tools
  that read them. Use `=`, not `??=`: an explicit empty value re-enables it.
- **Not avoidable by config:** `next dev` GETs `registry.npmjs.org/-/package/next/dist-tags`
  once per session to check for a newer Next; `npm install` / `npm ci` contact the registry
  (install plus the automatic audit). README badges (shields.io) load in GitHub readers'
  browsers, not in the app.

**Proving it** (all from the repo root, no root privileges needed):
```bash
# Telemetry as Next actually sees it (loads .env* and next.config.ts). Must print true.
# `npx next telemetry status` ignores both files and may still say "Enabled": do not trust it.
node -e 'const lc=require("next/dist/server/config").default;const {PHASE_PRODUCTION_BUILD}=require("next/constants");lc(PHASE_PRODUCTION_BUILD,process.cwd(),{silent:true}).then(()=>{const {Telemetry}=require("next/dist/telemetry/storage");console.log(new Telemetry({distDir:".next"}).isDisabled)})'
# Source greps that must return nothing:
grep -rniwE "posthog|sentry|gtag|googletagmanager|plausible|umami|mixpanel|hotjar|clarity|logrocket|bugsnag|rollbar|speed-insights|web-vitals|sendBeacon|report-uri|instrumentation" src next.config.ts package.json; grep -rn "@vercel/\|third-parties\|next/script" src package.json
grep -rn "next/font/google" src
# Exactly one hit, the Monaco wrapper:
grep -rn "loader.config" src
# After `npm run build`, no Google Fonts URL in the client output. (The jsDelivr string of
# @monaco-editor/loader's default config is still bundled but dead: loader.config() short-circuits it.)
grep -rlE "fonts\.g(oogleapis|static)\.com" .next/static
# Build with the network unshared (proves the fonts are vendored). Loopback must be up or
# Turbopack's worker pool hangs forever:
unshare -rn sh -c "ip link set lo up && npm run build"
# Every outbound connect during a build; expect nothing outside loopback:
strace -f -qq -e trace=connect -o /tmp/connect.log npm run build && grep -oE 'inet_(addr|pton)\([^)]*\)' /tmp/connect.log | sort -u | grep -vE '127\.0\.0\.|::1'
```
In the browser: DevTools → Network, open a project → Code tab; no `cdn.jsdelivr.net`, no
`fonts.gstatic.com`, worker scripts served from `/_next/static/`.

## 12. Boilerplate mode: put real users behind it

The "sell it under your brand" path: sign-up and login, a credit balance per user, Stripe
to top it up, every project tied to its owner. See https://www.totalum.app/whitelabel.

**Login and database (Supabase shown; any auth works)**
1. `npm i @supabase/supabase-js @supabase/ssr`. Env: `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server only).
2. Tables (RLS on): `profiles(user_id uuid pk, credits integer default 0)`,
   `projects(project_id text pk, user_id uuid, created_at)`.
3. `src/lib/supabase/server.ts`: `createServerClient` reading request cookies. A `/login`
   page with magic link or OAuth.
4. `_shared.ts`: `resolveVcaasContext()` reads the user from cookies and returns `401` when
   absent; `enforceProjectScope(team, method, path)` returns `403` when
   `path[0] === "projects" && path[1]` and the project is not the user's. Insert the
   returned `projectId` after `POST /projects` or `/projects/launch`.
5. **Wire the guards into every route.** Only `/api/preview/*` and `/api/visual-edit/*` call
   them today; the catch-all, `upload`, `source-code`, `git-diff` and `config` do not.
6. Filter the home page: intersect `projects.list()` with the user's rows in the catch-all
   for `GET /projects`.
7. Protect pages in `src/proxy.ts`: redirect `/` and `/project/*` to `/login` without a session.
8. Point `InsufficientCreditsModal` at your own checkout, not `BRAND.billingUrl`.

**Payments**
1. Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_*`.
2. `POST /api/billing/checkout`: Checkout Session with `client_reference_id = user.id`.
3. `POST /api/billing/webhook`: verify the signature; on `checkout.session.completed` /
   `invoice.paid`, `profiles.credits += pack_size`. Idempotent on the event id.
4. Gate spending in the catch-all before forwarding: on spend-shaped paths (`agent/start`,
   `projects/launch`, `deployments/deploy`, `versions/*/recover`,
   `agent/server/start-or-restart`, `domain`, `files/content` PUT, `rebuild`, `export`,
   `import`) with `profiles.credits <= 0`, return `{ok:false, code:"INSUFFICIENT_CREDITS"}`
   with 402. The UI already opens `InsufficientCreditsModal`.
5. Meter per prompt when `agent/status` reports `done` (`creditsSpent` is on the response),
   or use Totalum's webhooks. Reconcile against
   `GET /api/v1/credits/spending-analytics?projectId=`.

## 13. Adding an AI app builder to an existing product (any stack)

**A. Run it as-is beside your product.** Deploy on a subdomain (`builder.yourapp.com`),
put your login in front, link to `/project/<id>`. Rebrand via `brand.ts`.

**B. Port the flow into your own stack.** The UI is optional; the contract is not:
1. **A key-holding proxy** = `vcaas-server.ts` + the catch-all route: forward method, path,
   query and body to `https://api-accounts.totalum.app/api/v1/vcaas/<path>`, add
   `api-key`, return the `{errors, data}` envelope unchanged, refuse paths that escape.
2. **The minimum flow:** `POST /projects/launch` → poll `GET /projects/:id/agent/status`
   every 10–15 s until `done` → `GET /projects/:id` and show the URL named by
   `developmentUrlFieldToUse` in an iframe → follow-ups with `POST /projects/:id/agent/start`
   → `POST /projects/:id/deployments/deploy` → poll `deployments/status`.
3. **Tenancy** = one project per customer. Store `projectId ↔ tenant`, check it on every
   proxied `/projects/<id>/` path, filter `GET /projects` by your own table.

## 14. Dependencies

- Runtime: React 19, Radix (dialog, dropdown-menu, label, popover, select, slot, switch,
  tooltip actually used), `lucide-react`, `sonner`, `next-themes` (sonner theme only),
  cva/clsx/tailwind-merge, `@monaco-editor/react` + `monaco-editor`, `fflate`, `postcss`.
- Build/dev: Next 16, Tailwind 4 (`@tailwindcss/postcss`, `tw-animate-css`), TypeScript
  5.8 (also used at runtime by the visual-edit engine), ESLint 9.
- No auth, payment or AI SDK ships here; those belong to boilerplate mode.
- Before adding a dependency, confirm it is imported and `npm audit` stays at zero. A
  `dompurify` override pins the copy Monaco pulls in.

## 15. Boundaries

- ✅ Edit anything under `src/`, `README.md`, `AGENTS.md`, `CHANGELOG.md`, `.env.example`.
- ⚠️ Ask before: changing `_shared.ts` semantics, renaming `TOTALUM_VCAAS_API_KEY`, adding
  dependencies, replacing the theme with a dark one, re-copying platform files wholesale.
- 🚫 Never: commit `.env*` files or any `tlm_sk_` key; expose the key via `NEXT_PUBLIC_*`;
  call `api-accounts.totalum.app` from client code; vendor the API docs; use Lovable's
  name as the product name, or its logo or screenshots; run publish / restore / import /
  export / delete against real projects to "test"; add telemetry, analytics, CDN scripts or
  runtime-fetched fonts (§11); edit the `force-dynamic` / `revalidate` lines in `layout.tsx`.

## Git

Human contributors read `CONTRIBUTING.md`; issues and PRs use the templates under
`.github/`. PR description: what changed, why, and how it was verified in the browser.
