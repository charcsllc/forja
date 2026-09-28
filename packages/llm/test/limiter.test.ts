/**
 * Rate limiter with an injected clock. Protects: at most `rpm` starts per 60 s window,
 * at most `maxConcurrency` in flight, FIFO order, waiting instead of failing, abort.
 */
import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/gateway/limiter.js";

/** A clock that jumps forward whenever the limiter sleeps. */
function fakeClock(start = 0) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    /** Time passes only once everything already runnable has run (like a real timer). */
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleeps.push(ms);
        setImmediate(() => {
          t += ms;
          resolve();
        });
      }),
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("RateLimiter", () => {
  it("lets rpm requests start at once and delays the next one to the window edge", async () => {
    const clock = fakeClock(1_000);
    const limiter = new RateLimiter({ rpm: 2, now: clock.now, sleep: clock.sleep });
    const startedAt: number[] = [];
    const run = async () => {
      const release = await limiter.acquire();
      startedAt.push(clock.now());
      release();
    };
    await Promise.all([run(), run(), run()]);
    expect(startedAt).toEqual([1_000, 1_000, 61_000]);
    expect(clock.sleeps).toEqual([60_000]);
  });

  it("allows 40 requests per minute (NVIDIA free tier) and never errors", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ rpm: 40, now: clock.now, sleep: clock.sleep });
    const startedAt: number[] = [];
    await Promise.all(
      Array.from({ length: 100 }, async () => {
        const release = await limiter.acquire();
        startedAt.push(clock.now());
        release();
      }),
    );
    expect(startedAt).toHaveLength(100);
    for (let i = 0; i < 100; i++) {
      const inWindow = startedAt.filter((t) => t > startedAt[i]! - 60_000 && t <= startedAt[i]!).length;
      expect(inWindow).toBeLessThanOrEqual(40);
    }
    expect(startedAt.filter((t) => t === 0)).toHaveLength(40);
    expect(startedAt.at(-1)).toBe(120_000);
  });

  it("caps concurrency and serves waiters in FIFO order", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ maxConcurrency: 1, now: clock.now, sleep: clock.sleep });
    const order: string[] = [];
    const r1 = await limiter.acquire();
    const p2 = limiter.acquire().then((r) => (order.push("second"), r));
    const p3 = limiter.acquire().then((r) => (order.push("third"), r));
    await flush();
    expect(limiter.inFlight).toBe(1);
    expect(limiter.waiting).toBe(2);
    expect(order).toEqual([]);
    r1();
    r1(); // releasing twice is harmless
    const r2 = await p2;
    await flush();
    expect(order).toEqual(["second"]);
    r2();
    (await p3)();
    expect(order).toEqual(["second", "third"]);
    expect(limiter.inFlight).toBe(0);
  });

  it("rejects a waiting caller when its signal aborts, and keeps serving the others", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ maxConcurrency: 1, now: clock.now, sleep: clock.sleep });
    const r1 = await limiter.acquire();
    const controller = new AbortController();
    const aborted = limiter.acquire(controller.signal);
    const next = limiter.acquire();
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "aborted" });
    r1();
    const r3 = await next;
    expect(limiter.inFlight).toBe(1);
    r3();
  });

  it("without limits never waits", async () => {
    const limiter = new RateLimiter();
    const releases = await Promise.all(Array.from({ length: 50 }, () => limiter.acquire()));
    expect(limiter.inFlight).toBe(50);
    releases.forEach((r) => r());
  });
});
