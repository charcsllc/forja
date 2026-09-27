/**
 * Spanish templates for the messages the engine writes into the user's conversation.
 *
 * Protects: the same key set and placeholders as `en.ts` (keys enforced by the type,
 * placeholders by test). Plain words only: no task ids, no role names.
 */
import type { MessageKey } from "./en";

export const es: Readonly<Record<MessageKey, string>> = {
  "run.starting": "Analizando tu petición…",
  "run.stoppedByUser":
    "Detenido por el usuario. Los cambios parciales quedan en la versión de trabajo.",
  "run.budgetExhausted":
    "Este trabajo alcanzó su presupuesto ({spent} de {budget} USD) antes de terminar. Lo que quedó fuera: {skipped}",
  "run.internalError":
    "Algo falló por nuestra parte: {cause}. Tu proyecto está a salvo; puedes volver a intentarlo.",
  "run.noProvider":
    "No hay ningún proveedor de IA configurado, así que no se pudo construir nada. Pide al administrador que active uno y vuelve a intentarlo.",

  "phase.received": "Petición recibida",
  "phase.directing": "Analizando tu petición…",
  "phase.answering": "Investigando tu pregunta",
  "phase.designing": "Diseñando la identidad visual",
  "phase.modelling": "Diseñando el modelo de datos",
  "phase.implementing": "Construyendo tu aplicación",
  "phase.integrating": "Uniendo todas las piezas",
  "phase.verifying": "Comprobando que todo funciona",
  "phase.fixing": "Corrigiendo lo que encontraron las comprobaciones",
  "phase.reviewing": "Revisando el código y su seguridad",
  "phase.documenting": "Actualizando la documentación",
  "phase.finishing": "Guardando la nueva versión",
  "phase.cancelling": "Deteniendo…",
  "phase.done": "Listo",
  "phase.failed": "El trabajo no pudo terminar",
  "phase.limit-reached": "El trabajo alcanzó su presupuesto",
  "phase.cancelled": "Detenido",

  "task.director": "Planificando el trabajo",
  "task.designer": "Diseñando la identidad visual",
  "task.brand": "Creando el logotipo y los recursos de marca",
  "task.imagery": "Preparando las imágenes",
  "task.copywriter": "Escribiendo los textos",
  "task.database": "Preparando la base de datos",
  "task.database.named": "Preparando los datos de {title}",
  "task.backend": "Programando la lógica de la aplicación",
  "task.backend.named": "Programando {title}",
  "task.frontend": "Creando una página",
  "task.frontend.named": "Creando la página {title}",
  "task.supervisor": "Preparando el entorno",
  "task.qa": "Escribiendo las pruebas automáticas",
  "task.reviewer": "Revisando el código",
  "task.security": "Comprobando la seguridad",
  "task.docs": "Actualizando la documentación",
  "task.fixer": "Corrigiendo errores",
  "task.summarizer": "Resumiendo el progreso",

  "gates.progress": "Comprobando {done} de {total} verificaciones",
};
