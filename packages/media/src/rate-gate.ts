/**
 * Client-side rate limiting per search provider.
 *
 * Protects: anonymous and free-tier quotas (Openverse anonymous: 20/min burst, 200/day
 * sustained; Pexels 200/h; Pixabay 100/min; Unsplash demo 50/h) are never exceeded by
 * Forja itself, and a provider that answered 429 (or reported zero requests left) is
 * skipped until its cool-down ends. The gate **never sleeps**: a closed gate means "use
 * the next provider", so an agent turn is never blocked waiting on a quota.
 */
export interface RateWindow {
  windowMs: number;
  max: number;
}

export class RateGate {
  private readonly stamps: number[] = [];
  private cooldownUntil = 0;
  private readonly longest: number;

  constructor(
    private readonly windows: readonly RateWindow[],
    private readonly now: () => number = Date.now,
  ) {
    this.longest = Math.max(0, ...windows.map((w) => w.windowMs));
  }

  /** Why the gate is closed right now, or null. Does not consume. */
  blockedReason(): string | null {
    const t = this.now();
    if (t < this.cooldownUntil) return `cooling down for ${Math.ceil((this.cooldownUntil - t) / 1000)} s`;
    for (const w of this.windows) {
      const used = this.stamps.filter((s) => s > t - w.windowMs).length;
      if (used >= w.max) return `local limit of ${w.max} per ${Math.round(w.windowMs / 1000)} s reached`;
    }
    return null;
  }

  /** Takes one slot; false when closed. */
  tryAcquire(): boolean {
    if (this.blockedReason()) return false;
    const t = this.now();
    this.stamps.push(t);
    while (this.stamps.length > 0 && (this.stamps[0] ?? 0) <= t - this.longest) this.stamps.shift();
    return true;
  }

  coolDown(ms: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + Math.max(0, ms));
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
