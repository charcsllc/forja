/**
 * SSRF guard (ported from apps/web). Protects: https only, and no private target in any
 * spelling or through DNS.
 */
import { describe, expect, it } from "vitest";
import { isPrivateAddress, publicUrlRejectionReason, urlRejectionReason } from "../src/safe-url.js";
import { fakeLookup } from "./helpers.js";

describe("urlRejectionReason", () => {
  it.each([
    "http://example.com/a.jpg",
    "ftp://example.com/a.jpg",
    "https://user:pw@example.com/a.jpg",
    "https://localhost/a.jpg",
    "https://postgres/a.jpg",
    "https://metadata.google.internal/",
    "https://printer.local/",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/",
    "https://[::ffff:169.254.169.254]/",
    "https://[64:ff9b::a9fe:a9fe]/",
    "https://[fd00::1]/",
    "https://[fe80::1]/",
    "https://10.1.2.3/",
    "https://100.64.0.1/",
    "https://example.com:8443/",
    "not a url",
  ])("refuses %s", (url) => {
    expect(urlRejectionReason(url)).not.toBeNull();
  });

  it("accepts a public https URL", () => {
    expect(urlRejectionReason("https://upload.wikimedia.org/a.jpg")).toBeNull();
    expect(urlRejectionReason("https://93.184.216.34/a.jpg")).toBeNull();
  });
});

describe("publicUrlRejectionReason", () => {
  it("refuses a public name that resolves to metadata or a mapped loopback", async () => {
    expect(await publicUrlRejectionReason("https://evil.example/a.jpg", fakeLookup)).toMatch(/private/);
    expect(await publicUrlRejectionReason("https://mapped.example/a.jpg", fakeLookup)).toMatch(/private/);
  });
  it("refuses a name that does not resolve", async () => {
    expect(await publicUrlRejectionReason("https://nxdomain.example/a.jpg", fakeLookup)).toMatch(/resolved/);
  });
  it("accepts a name resolving to public addresses", async () => {
    expect(await publicUrlRejectionReason("https://live.staticflickr.com/a.jpg", fakeLookup)).toBeNull();
  });
  it("classifies addresses", () => {
    expect(isPrivateAddress("172.20.0.5")).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });
});
