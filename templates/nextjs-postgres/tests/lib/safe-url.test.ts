import { describe, expect, it } from "vitest";
import { isPrivateAddress, urlRejectionReason } from "@/lib/safe-url";
import { isUuidV7, uuidv7 } from "@/lib/uuid";

describe("safe-url", () => {
  it.each([
    "http://localhost/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::ffff:169.254.169.254]/",
    "http://[fd00::1]/",
    "http://100.64.0.1/",
    "http://service.internal/",
    "file:///etc/passwd",
    "https://user:pass@example.com/",
  ])("refuses %s", (url) => {
    expect(urlRejectionReason(url)).not.toBeNull();
  });

  it("accepts public URLs", () => {
    expect(urlRejectionReason("https://example.com/image.png")).toBeNull();
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
  });
});

describe("uuidv7", () => {
  it("generates sortable v7 ids", () => {
    const ids = Array.from({ length: 50 }, () => uuidv7());
    expect(ids.every(isUuidV7)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });
});
