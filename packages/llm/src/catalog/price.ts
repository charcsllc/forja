/**
 * Price functions and capability defaults for catalog entries.
 *
 * What this file protects: tariffs are expressed once, in USD per 1M tokens, exactly as
 * vendors publish them (flat, input-size tiers, peak/off-peak by UTC hour), and every
 * capability defaults to the conservative value (`false`/`none`) so a catalog entry has to
 * claim a capability explicitly.
 */
import type { ModelCapabilities, PriceFn, TokenUsage } from "./types.js";

/** USD per 1M tokens. `cachedInput` defaults to `input`, `cacheWrite` to `input`. */
export interface Per1M {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
}

const M = 1_000_000;

function cost(p: Per1M, u: TokenUsage): number {
  return (
    (u.input * p.input + u.output * p.output + u.cachedInput * (p.cachedInput ?? p.input) + u.cacheWrite * (p.cacheWrite ?? p.input)) / M
  );
}

export function flatPrice(p: Per1M): PriceFn {
  return (u) => cost(p, u);
}

/** Free tier: calls are rate-limited, not billed. */
export const FREE: PriceFn = () => 0;

/** A different tariff once the prompt (uncached + cached) exceeds `thresholdTokens`. */
export function promptTieredPrice(thresholdTokens: number, below: Per1M, above: Per1M): PriceFn {
  return (u) => cost(u.input + u.cachedInput > thresholdTokens ? above : below, u);
}

export interface PeakWindow {
  /** [fromHour, toHour) in UTC, 0–24. */
  hoursUtc: Array<[number, number]>;
  weekdaysOnly: boolean;
}

export function peakPrice(window: PeakWindow, peak: Per1M, offPeak: Per1M): PriceFn {
  return (u, at) => {
    const day = at.getUTCDay();
    const hour = at.getUTCHours();
    const weekday = day >= 1 && day <= 5;
    const inPeak = (!window.weekdaysOnly || weekday) && window.hoursUtc.some(([from, to]) => hour >= from && hour < to);
    return cost(inPeak ? peak : offPeak, u);
  };
}

/** Output price per 1M tokens at `at`: the figure the router sorts and caps on. */
export function outputPricePer1M(price: PriceFn, at: Date): number {
  return price({ input: 0, output: M, cachedInput: 0, cacheWrite: 0 }, at);
}

export const NO_CAPABILITIES: ModelCapabilities = {
  nativeTools: false,
  parallelTools: false,
  forcedToolChoice: false,
  jsonSchema: false,
  vision: false,
  thinking: "none",
  reasoningEcho: "none",
  streamingToolCalls: false,
};

export function caps(partial: Partial<ModelCapabilities>): ModelCapabilities {
  return { ...NO_CAPABILITIES, ...partial };
}
