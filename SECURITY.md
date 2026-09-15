# Security policy

## Reporting a vulnerability

Please report security issues privately through [GitHub private vulnerability reporting](https://github.com/totalumlabs/lovable-alternative/security/advisories/new) rather than a public issue. We aim to acknowledge reports within three working days.

## Scope

This repository is the builder UI. It ships with **no authentication by design**: every route is public and the app acts on one operator API key. Reports about "anyone can use the app without logging in" are expected behaviour until the operator adds an auth layer (see `AGENTS.md`, "Boilerplate mode").

In scope:

- The server proxy escaping `/api/v1/vcaas/` (see `resolveVcaasUrl` in `src/lib/vcaas-server.ts`).
- Server routes fetching client-supplied URLs without `publicUrlRejectionReason` (SSRF).
- The API key reaching the browser in any form.
- Dependency advisories (`npm audit` is kept at zero).

Issues in the Totalum API itself should go to Totalum support.
