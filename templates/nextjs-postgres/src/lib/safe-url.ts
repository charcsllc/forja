/**
 * Is this URL safe for the server to fetch? SSRF guard for every URL a user supplied.
 *
 * ⚠️ Any server code that fetches a client-supplied URL is an SSRF primitive until it calls
 * `publicUrlRejectionReason` (async: also resolves the name and judges every address). Pair
 * it with `redirect: "error"`, a timeout and a response size cap.
 *
 * Allow-shape, not a block-list: only http/https, no credentials in the URL, and any host
 * that is internal (by name, or as an IP literal in any spelling: decimal, hex, IPv4-mapped
 * IPv6, NAT64, link-local, unique-local…) is refused. IP literals are parsed, not
 * pattern-matched. The residual risk is DNS rebinding between the lookup and the fetch.
 *
 * Ported from the Forja builder (`apps/web/src/lib/safe-url.ts`); keep the two in step.
 */

/** Hostnames that are internal by definition, whatever they resolve to. */
function isInternalName(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".home.arpa")
  );
}

/** A dotted-quad IPv4 address as a 32-bit unsigned integer, or `null`. */
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

/** `[base, prefixLength]`: every range an outside caller must never reach through us. */
const PRIVATE_V4: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local: cloud metadata lives here
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including 255.255.255.255
];

const PRIVATE_V4_RANGES: [number, number][] = PRIVATE_V4.map(([base, bits]) => {
  const start = ipv4ToInt(base);
  if (start === null) throw new Error(`Bad range ${base}`);
  return [start, start + 2 ** (32 - bits)];
});

function isPrivateIPv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  return PRIVATE_V4_RANGES.some(([start, end]) => value >= start && value < end);
}

/** An IPv6 address expanded to its eight 16-bit groups, or `null` when it is not one. */
function expandIPv6(input: string): number[] | null {
  let ip = input.toLowerCase();
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);

  // A trailing dotted quad (`::ffff:1.2.3.4`) becomes two hex groups.
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
  // An IPv4 address wearing IPv6 clothing is judged as IPv4.
  if (allZeroUpTo(5) && at(5) === 0xffff) return isPrivateIPv4(embeddedV4()); // ::ffff:a.b.c.d
  if (allZeroUpTo(6)) return isPrivateIPv4(embeddedV4()); // ::a.b.c.d (deprecated)
  if (at(0) === 0x64 && at(1) === 0xff9b && at(2) === 0 && at(3) === 0 && at(4) === 0 && at(5) === 0) {
    return isPrivateIPv4(embeddedV4()); // 64:ff9b::/96 NAT64
  }
  if ((at(0) & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((at(0) & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((at(0) & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (at(0) === 0x2001 && at(1) === 0x0db8) return true; // documentation
  if (at(0) === 0x0100 && at(1) === 0 && at(2) === 0 && at(3) === 0) return true; // 100::/64 discard
  return false;
}

/** True for any address (v4 or v6, any spelling) an outside caller must not reach. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  if (bare.includes(":")) return isPrivateIPv6(bare);
  return isPrivateIPv4(bare);
}

function isIpLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  return bare.includes(":") ? expandIPv6(bare) !== null : ipv4ToInt(bare) !== null;
}

/**
 * Why this URL may not be fetched, or `null` when it may, judged from the URL alone.
 * Synchronous, so it cannot see where a name resolves: prefer `publicUrlRejectionReason`.
 */
export function urlRejectionReason(value: string): string | null {
  if (!value) return "No URL was provided";

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "That is not a valid URL";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Only http and https URLs can be used";
  }

  // Credentials in a URL are never needed for a public file and are a classic way to make
  // a URL read as one host while fetching another.
  if (parsed.username || parsed.password) return "That URL cannot be used";

  // The URL parser has already normalised decimal, hex and octal IPv4 spellings
  // (`http://2130706433/` → `127.0.0.1`), so the literal checks below see the real address.
  const host = parsed.hostname.toLowerCase();
  if (isInternalName(host)) return "That host cannot be reached from here";
  if (isIpLiteral(host) && isPrivateAddress(host)) return "That host cannot be reached from here";

  return null;
}

/**
 * The server-side check: everything `urlRejectionReason` does, then the name is RESOLVED and
 * every address it answers with is judged too. A lookup failure blocks. On a runtime without
 * `node:dns` (edge) the resolve step is skipped rather than blocking every URL.
 */
export async function publicUrlRejectionReason(value: string): Promise<string | null> {
  const literal = urlRejectionReason(value);
  if (literal) return literal;

  const host = new URL(value).hostname.toLowerCase();
  if (isIpLiteral(host)) return null; // already judged in full above

  type Lookup = (host: string, options: { all: true; verbatim: true }) => Promise<{ address: string }[]>;
  let lookup: Lookup | undefined;
  try {
    ({ lookup } = (await import("node:dns/promises")) as unknown as { lookup: Lookup });
  } catch {
    return null; // no DNS on this runtime (edge): rely on the synchronous checks
  }
  if (typeof lookup !== "function") return null;

  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (addresses.length === 0) return "That host could not be resolved";
    if (addresses.some((entry) => isPrivateAddress(entry.address))) {
      return "That host cannot be reached from here";
    }
  } catch {
    return "That host could not be resolved";
  }
  return null;
}

/**
 * Fetch a user-supplied URL safely: SSRF check, no redirects, timeout and size cap.
 * Returns the body as bytes, or throws with a readable reason.
 */
export async function safeFetch(
  url: string,
  {
    timeoutMs = 10_000,
    maxBytes = 10 * 1024 * 1024,
    init,
  }: { timeoutMs?: number; maxBytes?: number; init?: RequestInit } = {},
): Promise<{ response: Response; body: Uint8Array }> {
  const reason = await publicUrlRejectionReason(url);
  if (reason) throw new Error(reason);

  const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error("The response is too large");

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("The response is too large");
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { response, body };
}
