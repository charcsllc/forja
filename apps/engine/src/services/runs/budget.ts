/**
 * The run budget (02 §6, 03 §3): `BUDGET_PER_RUN_USD` split 65 % plan tasks (by weight),
 * 25 % verification and fixes, 10 % closing reserve; warning at 80 %, exhausted at 90 %.
 *
 * What this protects:
 * - ONE accounting source: the orchestrator charges from the loop's `usage` events (the
 *   same events that write `llm_calls`). The handle given to the gateway has a no-op
 *   `charge`, so a provider that also charges can never double-count.
 * - Past 90 % no new task starts; the 10 % reserve pays the gates and the closing message.
 * - `null` budget = unlimited (empty `BUDGET_PER_RUN_USD`).
 */
import type { BudgetHandle } from "@forja/llm";

export const PLAN_SHARE = 0.65;
export const VERIFY_SHARE = 0.25;
export const WARNING_RATIO = 0.8;
export const EXHAUSTED_RATIO = 0.9;

export interface BudgetSession {
  /** Passed to the loop and the gateway. */
  readonly handle: BudgetHandle;
  /** Records a cost of this session (called for every `usage` event). */
  add(usd: number): void;
  spent(): number;
}

export class RunBudget {
  private warned = false;
  private exhaustedFlag = false;

  constructor(
    readonly totalUsd: number | null,
    private spentUsd = 0,
  ) {}

  get spent(): number {
    return this.spentUsd;
  }

  get unlimited(): boolean {
    return this.totalUsd === null;
  }

  ratio(): number {
    return this.totalUsd === null || this.totalUsd === 0 ? (this.totalUsd === 0 ? 1 : 0) : this.spentUsd / this.totalUsd;
  }

  /** Adds a cost; returns the thresholds crossed by this charge (each reported once). */
  charge(usd: number): { warning: boolean; exhausted: boolean } {
    this.spentUsd += Math.max(0, usd);
    const r = this.ratio();
    const warning = !this.warned && r >= WARNING_RATIO;
    const exhausted = !this.exhaustedFlag && r >= EXHAUSTED_RATIO;
    if (warning) this.warned = true;
    if (exhausted) this.exhaustedFlag = true;
    return { warning, exhausted };
  }

  /** Past 90 %: pending work is cancelled; only the closing reserve may still be spent. */
  exhausted(): boolean {
    return this.totalUsd !== null && this.ratio() >= EXHAUSTED_RATIO;
  }

  /** USD of the plan share for a task of `weight` out of `totalWeight`. */
  taskAllocation(weight: number, totalWeight: number): number | null {
    if (this.totalUsd === null) return null;
    return (this.totalUsd * PLAN_SHARE * Math.max(weight, 0)) / Math.max(totalWeight, 1e-9);
  }

  verifyPool(): number | null {
    return this.totalUsd === null ? null : this.totalUsd * VERIFY_SHARE;
  }

  /**
   * A session capped at `capUsd` of its own spend and never past `ceiling` × the run
   * budget (0.9 for work, 1.0 for the closing reserve).
   */
  session(capUsd: number | null, ceiling = EXHAUSTED_RATIO): BudgetSession {
    let own = 0;
    const handle: BudgetHandle = {
      remainingUsd: () => {
        const run = this.totalUsd === null ? Number.POSITIVE_INFINITY : this.totalUsd * ceiling - this.spentUsd;
        const cap = capUsd === null ? Number.POSITIVE_INFINITY : capUsd - own;
        return Math.min(run, cap);
      },
      charge: () => undefined,
    };
    return {
      handle,
      add: (usd) => {
        own += Math.max(0, usd);
      },
      spent: () => own,
    };
  }
}
