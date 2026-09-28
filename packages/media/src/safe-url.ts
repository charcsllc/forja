/**
 * Is this URL safe for the engine to fetch? (docs/architecture/07 §1, SSRF row)
 *
 * Protects: an image URL comes from a search API answer, i.e. from data the engine does
 * not control. Fetching it runs with the engine's egress, which reaches Postgres, the
 * Docker socket proxy and the cloud metadata address. So every hop of every download is
 * judged here first: https only, no credentials, no internal names, and **every address
 * the name resolves to** must be public.
 *
 * Ported from `apps/web/src/lib/safe-url.ts` (same ranges, same parsing of IP literals in
 * every spelling: IPv4-mapped, IPv4-compatible and NAT64 IPv6 are unwrapped and judged
 * as IPv4). Deliberately not imported from the web app: packages never depend on apps.
 * Differences: https only (image hosts all serve TLS), and the DNS lookup is injectable
 * so tests never touch the network.
 *
 * ⚠️ Residual risk: DNS rebinding between this lookup and the fetch's own. Callers pair
 * this with manual redirects (each hop re-checked), a timeout and a size cap.
 */

export type LookupFn = (host: string) => Promise<string[]>;

/** Hostnames that are internal by definition, whatever they resolve to. */
function isInternalName(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".home.arpa") ||
    // Single-label names resolve through search domains (Docker service names: `postgres`).
    !host.includes(".")
  );
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

/** `[base, prefixLength]`: every range an outside-controlled URL must never reach. */
const PRIVATE_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local: cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isPrivateIPv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  return PRIVATE_V4.some(([base, bits]) => {
    const start = ipv4ToInt(base) ?? 0;
    const size = 2 ** (32 - bits);
    return value >= start && value < start + size;
  });
}

function expandIPv6(input: string): number[] | null {
  let ip = input.toLowerCase();
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);

  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    ip = `${ip.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;

  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    out.push(parseInt(group, 16));
  }
  return out;
}

function isPrivateIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return false;
  const at = (i: number): number => g[i] ?? 0;
  const allZeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  const embeddedV4 = () => `${at(6) >> 8}.${at(6) & 255}.${at(7) >> 8}.${at(7) & 255}`;

  if (g.every((x) => x === 0)) return true; // ::
  if (allZeroUpTo(7) && at(7) === 1) return true; // ::1
  if (allZeroUpTo(5) && at(5) === 0xffff) return isPrivateIPv4(embeddedV4()); // ::ffff:a.b.c.d
  if (allZeroUpTo(6)) return isPrivateIPv4(embeddedV4()); // ::a.b.c.d
  if (at(0) === 0x64 && at(1) === 0xff9b && at(2) === 0 && at(3) === 0 && at(4) === 0 && at(5) === 0) {
    return isPrivateIPv4(embeddedV4()); // 64:ff9b::/96 NAT64
  }
  if ((at(0) & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((at(0) & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((at(0) & 0xff00) === 0xff00) return true; // ff00::/8
  if (at(0) === 0x2001 && at(1) === 0x0db8) return true; // documentation
  if (at(0) === 0x0100 && at(1) === 0 && at(2) === 0 && at(3) === 0) return true; // 100::/64
  return false;
}

/** True for any address, v4 or v6 in any spelling, that must not be reached. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  if (bare.includes(":")) return isPrivateIPv6(bare);
  return isPrivateIPv4(bare);
}

function isIpLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  return bare.includes(":") ? expandIPv6(bare) !== null : ipv4ToInt(bare) !== null;
}

/** Why this URL may not be fetched, judged from the URL alone; `null` when it may. */
export function urlRejectionReason(value: string): string | null {
  if (!value) return "no URL";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "not a valid URL";
  }
  if (parsed.protocol !== "https:") return "only https URLs are fetched";
  if (parsed.username || parsed.password) return "URL carries credentials";
  if (parsed.port && parsed.port !== "443") return "non-standard port";
  const host = parsed.hostname.toLowerCase();
  if (isIpLiteral(host)) return isPrivateAddress(host) ? "private address" : null;
  if (isInternalName(host)) return "internal host name";
  return null;
}

/** The default lookup: every A/AAAA answer, as the OS resolver gives them. */
export const systemLookup: LookupFn = async (host) => {
  const { lookup } = await import("node:dns/promises");
  const answers = await lookup(host, { all: true, verbatim: true });
  return answers.map((a) => a.address);
};

/**
 * The full check: `urlRejectionReason`, then the name is resolved and every address it
 * answers with is judged. A lookup failure blocks (unlike the web edition there is no
 * edge runtime here: the engine always runs on Node).
 */
export async function publicUrlRejectionReason(value: string, lookup: LookupFn = systemLookup): Promise<string | null> {
  const literal = urlRejectionReason(value);
  if (literal) return literal;
  const host = new URL(value).hostname.toLowerCase();
  if (isIpLiteral(host)) return null;
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    return "host could not be resolved";
  }
  if (addresses.length === 0) return "host could not be resolved";
  if (addresses.some((a) => isPrivateAddress(a))) return "host resolves to a private address";
  return null;
}
