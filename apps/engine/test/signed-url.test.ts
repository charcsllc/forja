import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signPublicPath, signPublicToken, verifyPublicToken } from "../src/auth/signed-url.js";

const key = randomBytes(32).toString("base64");
const now = Date.UTC(2026, 8, 25, 12, 0, 0);

describe("signed public URLs", () => {
  it("round-trips project, resource and expiry", () => {
    const token = signPublicToken(key, { projectId: "velas", resource: "uploads/abc", ttlSeconds: 60, now });
    const res = verifyPublicToken(key, token, now + 1000);
    expect(res).toEqual({ ok: true, payload: { p: "velas", r: "uploads/abc", exp: now / 1000 + 60 } });
  });

  it("builds a /v1/public/ path", () => {
    const path = signPublicPath(key, { projectId: "velas", resource: "preview-image", ttlSeconds: 60, now });
    expect(path.startsWith("/v1/public/")).toBe(true);
    expect(verifyPublicToken(key, path.slice("/v1/public/".length), now).ok).toBe(true);
  });

  it("rejects expired tokens", () => {
    const token = signPublicToken(key, { projectId: "p1", resource: "r", ttlSeconds: 60, now });
    expect(verifyPublicToken(key, token, now + 60_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a token signed with another key", () => {
    const token = signPublicToken(randomBytes(32).toString("base64"), {
      projectId: "p1",
      resource: "r",
      ttlSeconds: 60,
      now,
    });
    expect(verifyPublicToken(key, token, now)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a tampered payload (another project)", () => {
    const token = signPublicToken(key, { projectId: "p1", resource: "r", ttlSeconds: 60, now });
    const sig = token.split(".")[1];
    const forged = Buffer.from(JSON.stringify({ p: "p2", r: "r", exp: now / 1000 + 60 })).toString("base64url");
    expect(verifyPublicToken(key, `${forged}.${sig}`, now)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects malformed tokens", () => {
    for (const t of ["", "abc", "a.b.c", "a$.b", "..."]) {
      expect(verifyPublicToken(key, t, now).ok).toBe(false);
    }
  });

  it("refuses to sign without a positive ttl", () => {
    expect(() => signPublicToken(key, { projectId: "p", resource: "r", ttlSeconds: 0 })).toThrow();
  });
});
