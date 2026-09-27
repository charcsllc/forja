/**
 * English templates for the messages the engine writes into the user's conversation.
 *
 * Protects: docs/architecture/05-data-model-and-api.md §2.4. Plain words only: no task
 * ids, no role names, no provider names. `{name}` placeholders are filled by `t()`.
 * This catalogue defines the key set; every other language must have the same keys and
 * the same placeholders (enforced by type for keys, by test for placeholders).
 */
export const en = {
  // Run lifecycle.
  "run.starting": "Analysing your request…",
  "run.stoppedByUser": "Stopped by you. The partial changes are kept in the working version.",
  "run.budgetExhausted":
    "This run reached its budget ({spent} of {budget} USD) before finishing. What was left out: {skipped}",
  "run.internalError": "Something went wrong on our side: {cause}. Your project is safe; you can try again.",
  "run.noProvider":
    "No AI provider is configured, so nothing could be built. Ask the administrator to enable one and try again.",

  // Phase changes (one per run status).
  "phase.received": "Request received",
  "phase.directing": "Analysing your request…",
  "phase.answering": "Looking into your question",
  "phase.designing": "Designing the look and feel",
  "phase.modelling": "Designing the data model",
  "phase.implementing": "Building your app",
  "phase.integrating": "Putting all the pieces together",
  "phase.verifying": "Checking that everything works",
  "phase.fixing": "Fixing what the checks found",
  "phase.reviewing": "Reviewing the code and its security",
  "phase.documenting": "Updating the documentation",
  "phase.finishing": "Saving the new version",
  "phase.cancelling": "Stopping…",
  "phase.done": "Done",
  "phase.failed": "The run could not finish",
  "phase.limit-reached": "The run reached its budget",
  "phase.cancelled": "Stopped",

  // A task starts. `.named` variants take a user-facing name (a page, a feature).
  "task.director": "Planning the work",
  "task.designer": "Designing the visual identity",
  "task.brand": "Creating the logo and brand assets",
  "task.imagery": "Preparing the images",
  "task.copywriter": "Writing the copy",
  "task.database": "Setting up the database",
  "task.database.named": "Setting up the data for {title}",
  "task.backend": "Building the app logic",
  "task.backend.named": "Building {title}",
  "task.frontend": "Building a page",
  "task.frontend.named": "Building the {title} page",
  "task.supervisor": "Preparing the environment",
  "task.qa": "Writing the automated tests",
  "task.reviewer": "Reviewing the code",
  "task.security": "Checking security",
  "task.docs": "Updating the documentation",
  "task.fixer": "Fixing errors",
  "task.summarizer": "Summarising progress",

  // Verification.
  "gates.progress": "Running check {done} of {total}",
} as const;

export type MessageCatalog = typeof en;
export type MessageKey = keyof MessageCatalog;
