# Documentación de Forja Engine

Forja pasa de ser un cliente fino de la API de Totalum a un **constructor de aplicaciones
autoalojado y multiagente**: la interfaz actual se conserva, y todo lo que hacía Totalum
(agente de código, sandboxes, previews, base de datos, publicación, versiones) lo hace un
servicio propio, **Forja Engine**, que orquesta varios agentes de IA sobre cualquier
combinación de proveedores de modelos.

Este directorio es la fuente de verdad del diseño. Se escribió antes de implementar nada.
Cuando el código y estos documentos discrepen, gana el código y se corrige el documento en
el mismo commit (misma regla que `AGENTS.md`).

## Índice

### Investigación (lo que había)
- [01 · Cómo funciona Totalum](research/01-totalum-how-it-works.md): mecanismo real, qué conservar, qué mejorar.
- [02 · Contrato UI ↔ backend](research/02-ui-backend-contract.md): cada endpoint, forma y transición que la UI de Forja exige.
- [03 · Proveedores LLM y sistemas de agentes](research/03-llm-providers-and-agent-systems.md): catálogo de modelos, endpoints, rarezas y patrones probados.

### Arquitectura (lo que se construye)
- [00 · Visión y principios](architecture/00-vision-and-principles.md)
- [01 · Arquitectura del sistema](architecture/01-system-architecture.md): componentes, monorepo, flujo de una petición.
- [02 · Gateway LLM y proveedores](architecture/02-llm-gateway-and-providers.md): router, variables de entorno, capacidades, protocolos de herramientas, coste.
- [03 · Agentes y orquestación](architecture/03-agents-and-orchestration.md): roles, pipeline, DAG de tareas, handoffs, presupuestos, modos de fallo.
- [04 · Sandbox, preview y publicación](architecture/04-sandbox-preview-deploy.md): Docker, Traefik, versiones, dominios.
- [05 · Modelo de datos y API](architecture/05-data-model-and-api.md): esquema del engine, API de compatibilidad, API v2, eventos, CMS de base de datos.
- [06 · Plantilla de aplicación generada](architecture/06-generated-app-template.md): stack, estructura, `compose.yaml`, `Dockerfile`, convenciones sin deuda técnica.
- [07 · Seguridad y privacidad](architecture/07-security-and-privacy.md)
- [08 · Plan de migración](architecture/08-migration-plan.md): fases para retirar Totalum sin romper la UI.
- [09 · Referencia de variables de entorno](architecture/09-env-reference.md)
- [10 · Resoluciones de la revisión de diseño](architecture/10-review-resolutions.md): cada hallazgo del revisor adversarial y cómo quedó resuelto.
- [11 · Registro canónico de herramientas](architecture/11-tool-registry.md): nombres, esquemas, dónde corre cada una, qué rol la recibe.

### Prompts de los agentes
- [Índice de prompts](prompts/README.md): persona base, un prompt por rol y un adaptador por proveedor.

## Cómo leer esto según lo que vayas a hacer

| Vas a… | Lee |
|---|---|
| Entender el objetivo | 00, 01 |
| Añadir un proveedor de modelos | 02, 09, `prompts/providers/` |
| Añadir o cambiar un agente | 03, 11, `prompts/roles/` |
| Entender por qué algo es como es | 10 |
| Tocar sandboxes, previews o publicación | 04, 07 |
| Implementar la API que la UI consume | research/02, 05 |
| Cambiar lo que generan los agentes | 06 |
| Implementar por fases | 08 |
