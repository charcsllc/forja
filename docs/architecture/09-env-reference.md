# 09 · Referencia de variables de entorno

`.env.example` objetivo de `apps/engine` (y las pocas de `apps/web`). Todo tiene valor por
defecto salvo lo marcado obligatorio. Proveedores en formato de dos valores
`"<true|false>|<api_key>"`, **siempre entre comillas** (`02 §1`).

```dotenv
# ───────────── Proveedores LLM · "<activo>|<api_key>" ─────────────
# Con una sola clave de un proveedor completo (Anthropic, OpenAI, Google, Z.ai, Qwen, DeepSeek,
# Moonshot, MiniMax, Mistral, xAI, OpenRouter) Forja funciona entero. Groq/Ollama solos no
# cubren los roles con visión: el arranque lo dirá.
LLM_ANTHROPIC="false|"
LLM_OPENAI="false|"
LLM_GOOGLE="false|"
LLM_ZAI="false|"                 # China: LLM_ZAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
LLM_QWEN="false|"
LLM_DEEPSEEK="false|"
LLM_MOONSHOT="false|"
LLM_MINIMAX="false|"
LLM_MISTRAL="false|"
LLM_XAI="false|"
LLM_GROQ="false|"
LLM_TOGETHER="false|"
LLM_FIREWORKS="false|"
LLM_OPENROUTER="false|"
LLM_NVIDIA="false|"              # NVIDIA NIM (build.nvidia.com, clave nvapi-…); nivel gratuito ≈ 40 peticiones/min
LLM_OLLAMA="false|"              # local; clave opcional
LLM_LMSTUDIO="false|"
LLM_VLLM="false|"
# Opcionales por proveedor: LLM_<P>_BASE_URL, LLM_<P>_ORG, LLM_<P>_TIMEOUT_MS (espera hasta el primer byte),
# LLM_<P>_MAX_CONCURRENCY, LLM_<P>_RPM (peticiones por minuto; cola, nunca error),
# LLM_<P>_EXTRA_MODELS='[{"id":"…","contextTokens":…,"maxOutputTokens":…}]'
# LLM_NVIDIA_RPM=40                # defecto del catálogo; LLM_NVIDIA_TIMEOUT_MS=300000 por defecto (131 s al primer byte observados)
# Forma separada (si ambas existen y discrepan, error de arranque): LLM_<P>_ENABLED, LLM_<P>_API_KEY
# LLM_OLLAMA_BASE_URL=http://host.docker.internal:11434/v1

# ───────────── Proveedores de imágenes · mismo formato ─────────────
IMAGE_OPENAI="false|"  IMAGE_GOOGLE="false|"  IMAGE_FAL="false|"  IMAGE_REPLICATE="false|"  IMAGE_STABILITY="false|"
STOCK_PEXELS="false|"  STOCK_PIXABAY="false|"  STOCK_UNSPLASH="false|"    # Unsplash: el adaptador cumple sus términos de descarga/atribución
# true → nunca usar un modelo de generación de imágenes: buscar fotos con licencia abierta en la web
# (STOCK_* activos, luego Openverse y Wikimedia Commons, sin clave). Acepta true/false/1/0/yes/no/on/off.
# Es el valor por defecto de la instancia: el modal Settings de la UI puede sobrescribirlo (tabla
# `settings`, clave images.mode) y gana hasta "Reset to .env" (02 §7, 05 §3).
IMAGES_FROM_WEB_SEARCH=false

# ───────────── Modelos por rol · "proveedor:modelo" · opcional (auto si falta) ─────────────
# Roles: director designer brand imagery copywriter database backend frontend supervisor qa reviewer security docs fixer summarizer
# AGENT_DIRECTOR_MODEL=anthropic:claude-fable-5-1
# AGENT_DIRECTOR_FALLBACKS=anthropic:claude-opus-5-5,openai:gpt-6-sol
# AGENT_DIRECTOR_EFFORT=high
# AGENT_FRONTEND_MODEL=anthropic:claude-opus-5-5
# AGENT_FRONTEND_FALLBACKS=zai:glm-5.3,qwen:qwen3-coder-next
# AGENT_REVIEWER_MODEL=openai:gpt-6-sol        # familia distinta del implementador
# AGENT_FIXER_MODEL=deepseek:deepseek-flash
# AGENT_SUMMARIZER_MODEL=anthropic:claude-sonnet-5
# AGENT_<ROL>_TOOL_PROTOCOL=auto               # auto | native | xml
# AGENT_<ROL>_MAX_OUTPUT_TOKENS=16000          # implementadores: 32000

# Límites y política de reintentos (03 §6)
AGENT_MAX_PARALLEL_TASKS=1                     # v1 secuencial
AGENT_MAX_TURNS_PER_TASK=60
AGENT_TASK_LOCAL_RETRIES=2
AGENT_FIXER_PASSES=3
AGENT_MAX_FIX_ROUNDS=4
AGENT_MAX_REVIEW_ROUNDS=2
AGENT_CONTEXT_SOFT_LIMIT=0.6
ENGINE_MAX_CONCURRENT_RUNS=2
RUN_REQUIRE_PLAN_APPROVAL=false
RUN_ALLOW_QUESTIONS=false

# Presupuestos (USD; vacío = sin límite; 02 §6)
BUDGET_PER_RUN_USD=8
BUDGET_PER_PROJECT_MONTH_USD=60
BUDGET_GLOBAL_MONTH_USD=

# ───────────── Engine ─────────────
FORJA_ENGINE_KEY=                # servidor: obligatorio; local: lo genera el servicio init en /data/engine/engine.key
FORJA_MASTER_KEY=                # 32 bytes base64; servidor: obligatorio; local: init → /data/engine/master.key
DATABASE_URL=postgres://forja:forja@postgres:5432/forja
DATA_DIR=/data                   # dentro del engine
DATA_DIR_HOST=/srv/forja/data    # la MISMA carpeta vista por el daemon Docker (bind mounts); comprobado al arrancar
ENGINE_PORT=4000
ENGINE_INSTANCES=1               # >1 requiere REDIS_URL para el pub/sub de deltas
LOG_LEVEL=info
LOGS_RETENTION_DAYS=7
EVENTS_RETENTION_DAYS=30
UPLOAD_MAX_MB=8

# Sandboxes (04)
SANDBOX_DRIVER=docker            # docker | process (solo desarrollo de Forja)
SANDBOX_RUNTIME=                 # vacío = runc; runsc = gVisor
SANDBOX_MEM=2g
SANDBOX_CPUS=2
SANDBOX_PIDS=512
SANDBOX_EGRESS=internet          # internet | registry-only
SANDBOX_IDLE_MINUTES=120
SANDBOX_MAX_ACTIVE=5
SANDBOX_START_TIMEOUT_SEC=300
DISK_MIN_FREE_GB=5
PROJECT_MAX_SIZE_MB=2048
PROJECT_PURGE_AFTER_DAYS=7

# Preview y publicación (04 §4, §7)
PREVIEW_DOMAIN=forja.localhost
PREVIEW_TLS=false
PREVIEW_PUBLIC=true              # local. En modo servidor (PUBLISH_TLS=true) el valor por defecto es false
PUBLISH_DOMAIN=apps.forja.localhost
PUBLISH_TLS=false
PUBLISH_IP=                      # registros A para dominios personalizados
ACME_EMAIL=                      # obligatorio con *_TLS=true
ACME_DNS_PROVIDER=               # p. ej. cloudflare, route53, digitalocean (comodín por DNS-01); vacío = HTTP-01 por host
# ACME_DNS_<PROVIDER>_*=         # credenciales según el proveedor (documentación de Traefik)
TRAEFIK_DASHBOARD=false

# Pruebas de integración del engine (nunca en producción)
# FORJA_LLM_REPLAY_DIR=              # activa el proveedor record/replay sobre este directorio
# FORJA_LLM_REPLAY_MODE=replay-or-fail # replay-or-fail | record | passthrough (ver packages/llm/src/replay)

# Varios
ALLOW_ENV_EXPORT=false
NPM_ALLOWLIST_FILE=
BACKUP_DIR=
BACKUP_S3_ENDPOINT= BACKUP_S3_BUCKET= BACKUP_S3_ACCESS_KEY= BACKUP_S3_SECRET_KEY=
WEBHOOK_TIMEOUT_MS=10000

# ───────────── apps/web ─────────────
FORJA_ENGINE_URL=http://engine:4000     # si falta, la UI usa TOTALUM_VCAAS_API_KEY (hasta la fase 6)
# FORJA_ENGINE_KEY=                     # o el fichero compartido /data/engine/engine.key
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_TELEMETRY_DISABLED=1
# El esquema y los dominios de preview/publicación los recibe la UI por /api/config (no NEXT_PUBLIC_*).
```

## Validación al arrancar

```
Forja Engine 0.1.0
  providers   anthropic ✓ (4 models)   zai ✓ (5)   ollama ✓ (local)   openai ✗ disabled
  roles       director → anthropic:claude-fable-5-1 [fallback anthropic:claude-opus-5-5]
              designer → anthropic:claude-opus-5-5 (auto: vision, frontier)
              fixer    → zai:glm-5.3-flash (auto: fast)
  media       search: openverse, wikimedia (+ STOCK_* activos) · generate: none · IMAGES_FROM_WEB_SEARCH=false
  sandbox     docker 29.8.1 · runtime runc · egress internet · max active 5 · data dir check ok
  preview     http://<id>.forja.localhost (public) · publish http://<id>.apps.forja.localhost
  budgets     run $8 · project/month $60
```

Con un proveedor `misconfigured` (activo sin clave, o formas que discrepan) el engine **no
arranca** y el informe lo señala en rojo. Con cero proveedores activos arranca (previews y
edición manual funcionan) y los runs devuelven `NO_PROVIDER_ENABLED`. Con proveedores
activos que no cubren los requisitos de algún rol, no arranca y dice qué falta.
