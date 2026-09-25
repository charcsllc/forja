/**
 * Public signed surface (05 §2.3): HMAC-SHA256 tokens bound to a project and a resource,
 * with an expiry inside the token. Served to browsers through the UI
 * (`/api/files/<token>` → engine `/v1/public/<token>`), so the engine is never exposed.
 *
 * Token = base64url(JSON {p, r, exp}) + "." + base64url(HMAC-SHA256(subkey, payloadPart)).
 * `exp` is Unix seconds. The HMAC key is derived from FORJA_MASTER_KEY with a fixed label
 * so the master key is never used directly for two purposes (it also encrypts secrets).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface PublicTokenPayload {
  /** Project id (slug). */
  p: string;
  /** Resource inside the project, e.g. "uploads/<fileNameId>" or "preview-image". */
  r: string;
  /** Expiry, Unix seconds. */
  exp: number;
}

export type VerifyResult =
  | { ok: true; payload: PublicTokenPayload }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

export const PUBLIC_PATH_PREFIX = "/v1/public/";
const SUBKEY_LABEL = "forja:public-url:v1";

function subkey(masterKey: string): Buffer {
  return createHmac("sha256", Buffer.from(masterKey, "base64")).update(SUBKEY_LABEL).digest();
}

function mac(masterKey: string, payloadPart: string): Buffer {
  return createHmac("sha256", subkey(masterKey)).update(payloadPart).digest();
}

export interface SignOptions {
  projectId: string;
  resource: string;
  ttlSeconds: number;
  /** Current time in ms (tests). */
  now?: number;
}

export function signPublicToken(masterKey: string, opts: SignOptions): string {
  if (!opts.projectId || !opts.resource) throw new Error("projectId and resource are required");
  if (!(opts.ttlSeconds > 0)) throw new Error("ttlSeconds must be positive");
  const exp = Math.floor((opts.now ?? Date.now()) / 1000) + Math.floor(opts.ttlSeconds);
  const payload: PublicTokenPayload = { p: opts.projectId, r: opts.resource, exp };
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${payloadPart}.${mac(masterKey, payloadPart).toString("base64url")}`;
}

/** Engine-relative path of the public resource: `/v1/public/<token>`. */
export function signPublicPath(masterKey: string, opts: SignOptions): string {
  return `${PUBLIC_PATH_PREFIX}${signPublicToken(masterKey, opts)}`;
}

export function verifyPublicToken(masterKey: string, token: string, now: number = Date.now()): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadPart, sigPart] = parts as [string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(payloadPart) || !/^[A-Za-z0-9_-]+$/.test(sigPart)) {
    return { ok: false, reason: "malformed" };
  }
  const expected = mac(masterKey, payloadPart);
  const given = Buffer.from(sigPart, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad-signature" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as PublicTokenPayload).p !== "string" ||
    typeof (payload as PublicTokenPayload).r !== "string" ||
    typeof (payload as PublicTokenPayload).exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  const p = payload as PublicTokenPayload;
  if (Math.floor(now / 1000) >= p.exp) return { ok: false, reason: "expired" };
  return { ok: true, payload: { p: p.p, r: p.r, exp: p.exp } };
}
