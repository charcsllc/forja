/**
 * Per-provider request limiter: a sliding window of requests per minute plus a cap on
 * concurrent requests.
 *
 * What this file protects:
 * - Our own limit never fails a call: callers queue (FIFO) and wait. Only the caller's
 *   abort signal ends a wait early (`LlmError("aborted")`).
 * - A request counts against the window when it starts, so at most `rpm` requests start
 *   in any 60 s span (NVIDIA's free tier allows ≈40/min).
 * - Time is injected (`now`, `sleep`), so tests are deterministic.
 */
import { LlmError } from "../errors.js";

export interface LimiterOptions {
  /** Requests per window; undefined = unlimited. */
  rpm?: number;
  /** Concurrent requests; undefined = unlimited. */
  maxConcurrency?: number;
  windowMs?: number;
  now?: () => number;
  /** Resolves after `ms`; injected in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export type Release = () => void;

interface Waiter {
  resolve: (release: Release) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private readonly rpm: number | undefined;
  private readonly maxConcurrency: number | undefined;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly starts: number[] = [];
  private readonly queue: Waiter[] = [];
  private active = 0;
  private wakeScheduled = false;

  constructor(opts: LimiterOptions = {}) {
    this.rpm = opts.rpm;
    this.maxConcurrency = opts.maxConcurrency;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
  }

  /** Requests currently holding a slot. */
  get inFlight(): number {
    return this.active;
  }

  /** Callers waiting for a slot. */
  get waiting(): number {
    return this.queue.length;
  }

  /** Waits for a slot; call the returned function when the request is over. */
  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(new LlmError("aborted", "generation aborted while waiting for the rate limiter", { retryable: false }));
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const i = this.queue.indexOf(waiter);
          if (i !== -1) this.queue.splice(i, 1);
          reject(new LlmError("aborted", "generation aborted while waiting for the rate limiter", { retryable: false }));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.pump();
    });
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.starts.length > 0 && (this.starts[0] as number) <= cutoff) this.starts.shift();
  }

  private pump(): void {
    while (this.queue.length > 0) {
      if (this.maxConcurrency !== undefined && this.active >= this.maxConcurrency) return; // a release pumps again
      this.prune();
      if (this.rpm !== undefined && this.starts.length >= this.rpm) {
        this.scheduleWake((this.starts[0] as number) + this.windowMs - this.now());
        return;
      }
      const waiter = this.queue.shift() as Waiter;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.starts.push(this.now());
      this.active++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.pump();
      });
    }
  }

  private scheduleWake(ms: number): void {
    if (this.wakeScheduled) return;
    this.wakeScheduled = true;
    void this.sleep(Math.max(1, ms)).then(() => {
      this.wakeScheduled = false;
      this.pump();
    });
  }
}
