# 00 · Visión y principios

## Qué es Forja después de este rediseño

Un usuario escribe un prompt. Un **equipo de agentes de IA** con roles de ingeniería reales
(dirección técnica, diseño gráfico, identidad, imágenes, redacción, base de datos, backend,
frontend, DevOps, QA, revisión, seguridad y documentación) diseña, construye, verifica y
documenta una **aplicación Next.js full-stack con su propia base de datos Postgres**, la
levanta en un sandbox Docker local, la muestra en una preview con recarga en caliente, y la
deja lista para publicar con `docker compose up` o en un servidor propio con dominio.

Todo se ejecuta en la máquina o el servidor del operador. Las únicas salidas a Internet son
las llamadas a los proveedores de modelos que el operador haya activado con su clave, y las
APIs de imágenes que active.

## Qué cambia respecto a hoy

| Hoy (Totalum) | Después (Forja Engine) |
|---|---|
| Un agente opaco (Claude Code) en una VM de Totalum | Equipo de agentes con roles, prompts y modelos propios, elegibles por rol |
| Un solo proveedor de IA | Cualquier proveedor: Anthropic, OpenAI, Google, GLM, Qwen, DeepSeek, Kimi, MiniMax, Mistral, xAI, Groq, Together, Fireworks, OpenRouter, Ollama, LM Studio, vLLM |
| Polling cada 10 s, mensajes gruesos | Log de eventos tipado en streaming (SSE): plan, herramientas, diffs, tests, coste |
| Sin verificación | Puertas duras: typecheck, lint, build, tests, arranque real, smoke con navegador |
| MongoDB propietario vía SDK | Postgres con migraciones en el repo; la app funciona sola |
| Rebuild frío de 1–4 min por edición | `next dev` con HMR; la edición manual es instantánea |
| Producción solo en Cloudflare Workers | `Dockerfile` + `compose.yaml` generados; local, VPS o cualquier nube |
| Créditos de un tercero | Coste real por tokens y modelo, con presupuestos por ejecución y proyecto |
| Secretos legibles por un endpoint | Secretos cifrados de solo escritura |

## Principios de diseño (no negociables)

1. **La UI actual sobrevive.** Forja Engine implementa primero el contrato exacto que la UI
   ya consume (`docs/research/02-ui-backend-contract.md`). La migración empieza cambiando una
   URL y una cabecera, no reescribiendo pantallas. Las mejoras (streaming, plan visible)
   llegan por una API v2 al lado, no en lugar de la v1.
2. **Un agente = un rol, un prompt, un modelo elegible.** Cada rol tiene un prompt propio y
   un modelo configurable por variable de entorno con fallbacks. Ningún rol depende de un
   proveedor concreto.
3. **Proveedores enchufables por variable de entorno.** Un proveedor se activa con una sola
   variable con dos valores: `LLM_<PROVEEDOR>="true|<api_key>"`. Sin clave, no existe. Con
   una sola clave de cualquier proveedor, Forja funciona entero (el router asigna roles).
4. **Determinismo alrededor de la IA.** Todo lo que pueda ser código, es código: puertas de
   calidad, merge, generación de `compose.yaml` base, migraciones, versionado. La IA decide,
   el código verifica.
5. **Cada mutación es un commit.** El repositorio git del proyecto es la fuente de verdad.
   Versiones = commits. Restaurar = revert hacia delante. Diff = `git diff` sin sandbox.
6. **Sin deuda técnica en lo generado.** La plantilla y los prompts imponen arquitectura por
   módulos, tipado estricto, migraciones versionadas, tests, ADRs y un `AGENTS.md` en cada
   proyecto generado, para que actualizar o migrar sea mecánico.
7. **Sandbox por defecto, no por opción.** El código generado nunca se ejecuta en el host:
   contenedor no root, capacidades mínimas, red por proyecto, límites de CPU/memoria/pids.
8. **Coste visible y acotado.** Cada llamada registra tokens y coste. Cada ejecución y cada
   proyecto tienen presupuesto, con una reserva de cierre dentro del propio presupuesto.
   Al agotarse, la ejecución se cierra ordenadamente con esa reserva y lo dice.
9. **Privacidad: nada sale que no se haya activado.** Sin telemetría, sin CDNs, sin fuentes
   remotas. Los únicos destinos son los proveedores activados, el registro npm, y, si se
   activan, Let's Encrypt, GitHub y Figma; la tabla exacta está en `07-security-and-privacy.md §3`.
10. **Local-first, servidor-ready.** El mismo `compose.yaml` de la plataforma corre en un
    portátil y en un VPS. Publicar en local es un contenedor de producción tras Traefik;
    publicar en Internet es el mismo contenedor con un dominio y un certificado.

## Qué no es (por ahora)

- No es multi-tenant con login y facturación. El modelo sigue siendo "un operador, una
  instancia". Las costuras para añadir usuarios están descritas en 07 y 08, pero no se
  construyen en la primera versión.
- No genera stacks distintos de Next.js + Postgres. La plantilla es una; el diseño permite
  añadir otras después (ver 06), pero la primera versión no lo hace.
- No reemplaza la sincronización con GitHub ni la importación de Figma de golpe: se
  mantienen como integraciones aisladas con sus propias fases en el plan de migración.

## Glosario

- **Engine.** El servicio propio (`apps/engine`) que sustituye a la API de Totalum.
- **Run (ejecución).** Una petición del usuario procesada de principio a fin por el equipo de agentes.
- **Rol.** Un tipo de agente con prompt propio (`director`, `designer`, `frontend`…).
- **Tarea.** Unidad de trabajo del DAG que el director asigna a un rol, con alcance de ficheros y criterios de aceptación.
- **Sandbox.** Los contenedores Docker de un proyecto: app, base de datos y red.
- **Puerta (gate).** Verificación determinista que debe pasar antes de avanzar de fase.
- **Versión.** Un commit etiquetado en el repositorio del proyecto.
