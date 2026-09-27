# Prompts de los agentes

Cada agente recibe un prompt de sistema ensamblado en este orden:

1. `_base-engineer.md`: la persona común a todos los roles de ingeniería.
2. `roles/<rol>.md`: misión, entradas, salidas, proceso, reglas y formato de entrega del rol.
3. `providers/<proveedor>.md`: instrucciones específicas del proveedor que ejecuta el rol
   (formato de herramientas, thinking, límites, manías conocidas). Para agregadores y
   locales (`openrouter`, `together`, `fireworks`, `ollama`, `lmstudio`, `vllm`) se añade a
   continuación el fichero de la **familia** del modelo (`zai`, `qwen`, `deepseek`,
   `moonshot`, `minimax`, `mistral`, `anthropic`, `openai`, `google`).
4. Sección "Tool protocol" (solo si el adaptador usa XML, `02 §5`).
5. Cabecera de contexto generada por el orquestador: herramientas disponibles con sus
   esquemas exactos (`11-tool-registry.md`), el esquema de la herramienta `submit_*` del
   rol, límites (turnos, presupuesto de la tarea), hoja de referencia de Next.js 16, y el
   contexto de la tarea (spec, decisiones, sistema de diseño, `AGENTS.md` del proyecto,
   criterios de aceptación, informes de tareas previas).

**Los prompts están en inglés** a propósito: todos los modelos del catálogo, incluidos GLM,
Qwen, DeepSeek y Kimi, siguen instrucciones en inglés con más fidelidad que en español, y
sus datos de entrenamiento de código son mayoritariamente en inglés. El idioma en el que el
agente **habla con el usuario** es otra cosa: siempre el idioma del usuario (regla en la
persona base). Los ficheros aquí son la fuente; `packages/agents` los empaqueta en build.

## Roles

| Fichero | Rol | Fase del pipeline |
|---|---|---|
| `roles/director.md` | Dirección técnica, planificación, decisiones, mensaje al usuario | directing, done |
| `roles/designer.md` | Diseño gráfico y UI/UX, sistema de diseño, revisión visual | designing, verifying |
| `roles/brand.md` | Logo, favicon, iconos, Open Graph, guía de identidad | designing |
| `roles/imagery.md` | Búsqueda y generación de imágenes, optimización, licencias | designing/implementing |
| `roles/copywriter.md` | Textos, SEO, metadatos, i18n, alt | designing |
| `roles/database.md` | Modelo de datos, esquema, migraciones, seed, consultas | modelling |
| `roles/backend.md` | Casos de uso, APIs, auth, integraciones | implementing |
| `roles/frontend.md` | Páginas, componentes, responsive, accesibilidad | implementing |
| `roles/supervisor.md` | Integración, Dockerfile, compose, entorno, vigilancia | integrating |
| `roles/qa.md` | Puertas, tests, smoke con navegador | verifying |
| `roles/reviewer.md` | Revisión de código contra spec y arquitectura | reviewing |
| `roles/security.md` | Revisión de seguridad | reviewing |
| `roles/docs.md` | README, AGENTS.md, ADRs, changelog | documenting |
| `roles/fixer.md` | Arreglos mecánicos de tipos y lint | verifying |
| `roles/summarizer.md` | Compactación de contexto y resúmenes de handoff | transversal |

## Proveedores

`providers/anthropic.md`, `openai.md`, `google.md`, `zai.md`, `qwen.md`, `deepseek.md`,
`moonshot.md`, `minimax.md`, `mistral.md`, `xai.md`, `groq.md`, `together.md`,
`fireworks.md`, `openrouter.md`, `ollama.md`, `lmstudio.md`, `vllm.md`.

## Convenciones al editar un prompt

- Segunda persona, imperativo, frases cortas. Sin adjetivos vacíos.
- Cada regla debe ser verificable. "Escribe código limpio" no; "una exportación principal
  por fichero" sí.
- Las salidas estructuradas se describen con su esquema exacto; el orquestador las valida.
- Los cambios en un prompt se prueban con `npm run agents:eval -- <rol>` (conjunto de
  tareas de referencia por rol con criterios automáticos) antes de fusionar.
- Un prompt nunca contiene nombres de proveedor ni de modelo (eso va en `providers/`).
