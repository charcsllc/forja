/**
 * The operation slot: one heavy operation per project, with a TTL (05 §1 `operations`).
 *
 * Protects:
 * - `acquire` either returns a token or throws `OPERATION_IN_PROGRESS` (409) naming the
 *   operation that holds the slot, so two rebuilds, a restore during a restart, etc. can
 *   never interleave.
 * - Jobs carry the token; `release(projectId, token)` only frees the slot it was given, so a
 *   job that outlived its TTL cannot free a newer operation's slot.
 * - TTLs are a crash backstop, not a deadline: long jobs call `extend` while they work.
 */
import { randomBytes } from "node:crypto";
import { engineError } from "../http/errors.js";
import type { OperationKind, Store } from "../store/types.js";

export const OPERATION_TTL_MS: Readonly<Record<OperationKind, number>> = {
  provision: 20 * 60_000,
  wake: 10 * 60_000,
  restartServer: 8 * 60_000,
  rebuild: 15 * 60_000,
  restoreVersion: 15 * 60_000,
  archive: 5 * 60_000,
  remove: 5 * 60_000,
};

export function newToken(): string {
  return randomBytes(12).toString("base64url");
}

export async function tryAcquire(
  store: Store,
  projectId: string,
  kind: OperationKind,
  extra: Record<string, unknown> = {},
): Promise<{ ok: true; token: string } | { ok: false; kind: string }> {
  const token = newToken();
  const result = await store.acquireOperation(projectId, kind, OPERATION_TTL_MS[kind], { ...extra, token });
  return result.ok ? { ok: true, token } : { ok: false, kind: result.current.kind };
}

export async function acquire(store: Store, projectId: string, kind: OperationKind, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await tryAcquire(store, projectId, kind, extra);
  if (!r.ok) {
    throw engineError("OPERATION_IN_PROGRESS", `Another operation (${r.kind}) is running on this project; try again when it finishes.`, {
      operation: r.kind,
    });
  }
  return r.token;
}

/** True while `token` still holds the project's slot. */
export async function holds(store: Store, projectId: string, token: string): Promise<boolean> {
  const op = await store.getOperation(projectId);
  return !!op && (op.payload as { token?: string }).token === token;
}
