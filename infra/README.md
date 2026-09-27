# infra/: the Forja platform stack

`compose.yaml` runs the whole platform on one Docker host: the builder UI (`web`), the
Forja Engine (`engine`), its Postgres, Traefik, a Docker socket proxy and the browser
sidecar. Design: `docs/architecture/01-system-architecture.md`, `04-sandbox-preview-deploy.md`
(§1 networks, §4 Traefik) and `07-security-and-privacy.md` (§1 threat model).

> **Phase 1 status.** The UI talks to the engine (no Totalum key needed). The engine
> creates projects from `templates/nextjs-postgres`, runs each one in hardened Docker
> sandboxes with its own Postgres (migrated and seeded), serves previews through Traefik
> and through `/v2/projects/:id/preview/*`, and implements the v1 file, version, restore,
> rebuild, restart, upload, source-code, logs, secrets and database endpoints. The AI
> agents arrive in **phase 2**: until then `agent/start` answers `NOT_IMPLEMENTED`.
> Images needed: `docker compose build engine web` and
> `docker build -t forja-runner:1.0.0 -f infra/images/runner/Dockerfile .`.

## Run it

```bash
cp infra/.env.example infra/.env          # set POSTGRES_PASSWORD and DATA_DIR_HOST
sudo mkdir -p /srv/forja/data              # or any folder; must match DATA_DIR_HOST
docker compose -f infra/compose.yaml --env-file infra/.env up -d
docker compose -f infra/compose.yaml --env-file infra/.env ps
open http://localhost:3000                 # the UI; previews at http://<id>.forja.localhost
```

Validate without starting anything: `docker compose -f infra/compose.yaml --env-file infra/.env config -q`.

The first `up` builds `forja-engine:local`, `forja-web:local` and `forja-browser:local`
(the Playwright base image alone is ~2 GB) and pulls `postgres:17-alpine`, `traefik:v3.7`,
`tecnativa/docker-socket-proxy:v0.5.0` and `alpine:3.22`. Budget ~5 GB of disk.

What happens on `up`:

1. `init` (alpine, one-shot) creates `DATA_DIR_HOST/{engine,projects,traefik/dynamic}`,
   generates `engine/engine.key` and `engine/master.key` if missing (mode 600, uid 1000),
   copies **only** `engine.key` into the `forja-data` volume, and exits.
2. `postgres` becomes healthy; `engine` boots: config → keys (env, else the files) → DATA_DIR
   check → migrations (advisory lock) → pg-boss (`pgboss` schema) → HTTP on :4000.
3. `web` starts once the engine is healthy. `web-entrypoint.sh` exports `FORJA_ENGINE_KEY`
   from `/data/engine/engine.key` (the read-only `forja-data` volume) and runs Next.

Back up `DATA_DIR_HOST/engine/master.key`: it decrypts every project secret. In server
mode (`PUBLISH_TLS=true`) set `FORJA_ENGINE_KEY` and `FORJA_MASTER_KEY` in `infra/.env`
instead; the engine refuses to start without them.

### Publishing the engine port (optional)

The engine publishes nothing by default. To call it from the host:

```bash
echo 'ENGINE_EXPOSE=127.0.0.1:4000' >> infra/.env
docker compose -f infra/compose.yaml -f infra/compose.expose.yaml --env-file infra/.env up -d
curl -s localhost:4000/v2/system/health
curl -s -H "api-key: $(sudo cat /srv/forja/data/engine/engine.key)" localhost:4000/v1/account
```

## Network topology

| Network | Members | Notes |
|---|---|---|
| `forja-core` (bridge `fj-core`) | web, engine, postgres, traefik | The only network `web` is on. Engine's default route. |
| `forja-apps` (bridge `fj-apps`) | engine, traefik, browser, **every** project container | Fixed name: the engine attaches sandboxes to it and Traefik labels reference it. |
| `forja-docker` (bridge `fj-docker`, internal) | engine, traefik, socket-proxy | Nobody else can reach the Docker API. |
| `forja-int-<id>` (phase 1, internal) | app, verify and DB containers of one project | Created and removed by the engine. |

**Why `web` is not on `forja-apps`** (07 §1). Generated code runs in the project
containers on `forja-apps`. The web server holds `FORJA_ENGINE_KEY` and, until phase 6,
the Totalum key, and it exposes an unauthenticated API that spends credits (AGENTS.md
§0). If web were on `forja-apps`, any generated app could call `http://web:3000/api/...`
and act as the operator. Web therefore lives only on `forja-core`, is published only on
`127.0.0.1:3000` locally (or behind Traefik on a server), and reaches previews through
the engine (`/v2/projects/:id/preview/*`, phase 1). The engine is on `forja-apps` because
it must reach sandboxes; there it only answers with a valid `api-key`.

**Why the socket proxy has its own network.** The proxy allows `POST` (the engine
creates containers), which is equivalent to root on the host. Putting it on `forja-core`
would hand that to `web` and `postgres` too; `forja-docker` is `internal` and holds only
the engine and Traefik. (The phase-0 brief put it on `forja-core`; this is stricter.)
Traefik shares the engine's proxy; doc 04 §4 describes a separate read-only proxy for
Traefik. Splitting it is a one-service change if you want that extra layer.

Allowed proxy sections: `CONTAINERS IMAGES NETWORKS VOLUMES EXEC BUILD POST` for the
engine, plus `EVENTS`, which Traefik's Docker provider needs to notice containers.
`PING` and `VERSION` keep the image default (on). Everything else is `0`.

## Required host firewall rules (Linux)

Docker isolates bridges from each other, but not from the **host itself**, the LAN or
cloud metadata. A generated app could otherwise reach the host's SSH, a database
listening on `0.0.0.0`, a router admin page or `169.254.169.254`. Two chains close
that; both match the fixed bridge names (`fj-apps`, and the `fj-i*` names the engine
gives project networks from phase 1).

- **`INPUT`**: traffic *to the host's own addresses* (including the bridge gateway) never
  crosses `FORWARD`, so `DOCKER-USER` alone cannot stop it.
- **`DOCKER-USER`**: forwarded traffic to private ranges. Traffic that stays on
  `forja-apps` (Traefik, engine, browser) or on the project's internal network is left to
  Docker's own rules. Publishing through the host's ports 80/443 is DNAT'd to Traefik on
  `forja-apps`, so it stays allowed: those are the only host ports sandboxes reach.

```bash
# Sandboxes → the host itself: only replies to connections the host opened.
sudo iptables -N FORJA-SANDBOX-IN 2>/dev/null || sudo iptables -F FORJA-SANDBOX-IN
sudo iptables -A FORJA-SANDBOX-IN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
sudo iptables -A FORJA-SANDBOX-IN -j DROP
sudo iptables -C INPUT -i fj-apps -j FORJA-SANDBOX-IN 2>/dev/null || sudo iptables -I INPUT -i fj-apps -j FORJA-SANDBOX-IN
sudo iptables -C INPUT -i fj-i+   -j FORJA-SANDBOX-IN 2>/dev/null || sudo iptables -I INPUT -i fj-i+   -j FORJA-SANDBOX-IN

# Sandboxes → private ranges (LAN, other Docker networks, metadata). The Internet stays open.
sudo iptables -N FORJA-SANDBOX-FWD 2>/dev/null || sudo iptables -F FORJA-SANDBOX-FWD
sudo iptables -A FORJA-SANDBOX-FWD -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
sudo iptables -A FORJA-SANDBOX-FWD -o fj-apps -j RETURN   # Traefik (incl. hairpin via host :80/:443), engine, browser
sudo iptables -A FORJA-SANDBOX-FWD -o fj-i+   -j RETURN   # the project's own internal network (Docker still isolates projects)
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
  sudo iptables -A FORJA-SANDBOX-FWD -d "$net" -j DROP
done
sudo iptables -A FORJA-SANDBOX-FWD -j RETURN
sudo iptables -C DOCKER-USER -i fj-apps -j FORJA-SANDBOX-FWD 2>/dev/null || sudo iptables -I DOCKER-USER -i fj-apps -j FORJA-SANDBOX-FWD
sudo iptables -C DOCKER-USER -i fj-i+   -j FORJA-SANDBOX-FWD 2>/dev/null || sudo iptables -I DOCKER-USER -i fj-i+   -j FORJA-SANDBOX-FWD
```

Notes:

- The engine and Traefik also sit on `forja-apps` and are subject to these rules on that
  interface. The engine's default route is `forja-core` (`gw_priority` in compose), so
  `host.docker.internal` (Ollama, LM Studio on the host) still works from the engine.
- Persist the rules (`sudo apt install iptables-persistent && sudo netfilter-persistent save`,
  or a systemd unit that runs the block above after `docker.service`). Docker creates
  `DOCKER-USER` but never flushes it.
- If you run Docker's nftables backend or firewalld, express the same rules there.
  If you enable IPv6 on these networks, mirror them with `ip6tables`.
- Check: `docker run --rm --network forja-apps alpine wget -qO- -T 3 http://<host-LAN-IP>:22`
  must time out, while `http://traefik` must answer.

## Docker address pools

Every active project gets its own internal network (`forja-int-<id>`, phase 1). Docker's
default pools give ~30 networks before `could not find an available, non-overlapping IPv4
address pool`. Archived projects' networks are removed, so `SANDBOX_MAX_ACTIVE=5` stays
well under that, but a host that also runs other compose projects can hit the limit.
Give Docker small subnets in `/etc/docker/daemon.json` and restart it:

```json
{
  "default-address-pools": [{ "base": "10.201.0.0/16", "size": 24 }]
}
```

That is 256 networks of 254 addresses. Pick a range that does not overlap your LAN or VPN.
The `DOCKER-USER` rules above already cover all of `10.0.0.0/8`.

## Docker Desktop (macOS, Windows)

- The `iptables` rules do not apply: containers run in Docker Desktop's VM and the host
  is reached through `host.docker.internal`. Sandboxes *can* reach services on your Mac or
  PC through it. Do not run sensitive services on all interfaces while using Forja there.
- `DATA_DIR_HOST` must be under a folder shared with Docker Desktop (Settings → Resources →
  File sharing), e.g. `/Users/<you>/forja-data`.
- Bind mounts do not deliver file events reliably, so `next dev` in the sandboxes needs
  `WATCHPACK_POLLING=true` for HMR. The engine sets it for sandboxes from phase 1.
- Local models: `LLM_OLLAMA_BASE_URL=http://host.docker.internal:11434/v1` (the engine has
  `extra_hosts: host.docker.internal:host-gateway`, which also makes it work on Linux).
- `*.localhost` resolves to loopback in Chrome and Firefox; Safari is checked in phase 1.

## Images and Dockerfiles

- `apps/engine/Dockerfile`: `node:22-bookworm-slim`, multi-stage, uid 1000, `git` and
  `tini`, only `dist/`, `drizzle/` and production dependencies in the runtime image;
  `HEALTHCHECK` on `/v2/system/health`.
- `apps/web/Dockerfile`: builds the UI from the workspace root. `apps/web/next.config.ts`
  does **not** set `output: "standalone"` yet; phase 1 adds it. Until then the image carries
  the full install and runs `next start` (next, typescript and tailwindcss are
  devDependencies the app needs at run time). Once standalone output exists, the same
  Dockerfile ships only the traced server, with no edits.
- `images/browser/`: `mcr.microsoft.com/playwright:v1.63.0-noble` + `sharp`, an HTTP stub
  (`GET /healthz` → 200, anything else → 501) until phase 3.
- The build context is the repository root; `/.dockerignore` keeps `node_modules`, `.next`,
  `dist`, `.git`, `docs` and every `.env*` except the examples out of it.

## Traefik

Static configuration: `traefik/traefik.yml` (entry points `web` :80 and `websecure` :443,
Docker provider through the socket proxy with `exposedByDefault: false` on `forja-apps`,
file provider on `/data/traefik/dynamic`). The engine writes the dynamic files: see
`traefik/dynamic/README.md`. ACME resolvers and the dashboard arrive in phase 4.
