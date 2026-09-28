/**
 * Model health: degradation after repeated transient failures, with a cooldown.
 *
 * What this file protects: a model that keeps answering 429/5xx/timeouts is moved to the
 * back of every chain for `cooldownMs`, so a struggling endpoint does not eat each run's
 * latency budget; it is never removed (it stays the last resort) and one success heals it.
 */
import type { LlmError } from "../errors.js";

const TRANSIENT = new Set(["rate_limited", "unavailable", "timeout"]);

export class ModelHealth {
  private readonly failures = new Map<string, number>();
  private readonly degradedUntil = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private readonly threshold = 3,
    private readonly cooldownMs = 60_000,
  ) {}

  /** Records a failure; returns true when this failure degraded the model. */
  failure(ref: string, err: LlmError): boolean {
    if (!TRANSIENT.has(err.code)) return false;
    const n = (this.failures.get(ref) ?? 0) + 1;
    this.failures.set(ref, n);
    if (n >= this.threshold && !this.isDegraded(ref)) {
      this.degradedUntil.set(ref, this.now() + this.cooldownMs);
      this.failures.set(ref, 0);
      return true;
    }
    return false;
  }

  success(ref: string): void {
    this.failures.delete(ref);
    this.degradedUntil.delete(ref);
  }

  isDegraded(ref: string): boolean {
    const until = this.degradedUntil.get(ref);
    if (until === undefined) return false;
    if (this.now() >= until) {
      this.degradedUntil.delete(ref);
      return false;
    }
    return true;
  }
}
