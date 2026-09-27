import { describe, expect, it } from "vitest";
import { redactDeep } from "../src/logger.js";

describe("log redaction", () => {
  it("masks sensitive keys at any depth", () => {
    const out = redactDeep({
      headers: { "api-key": "tlm", authorization: "Bearer x", accept: "json" },
      nested: { githubToken: "t", dbPassword: "p", clientSecret: "s", runId: "r1" },
      list: [{ apiKey: "k" }],
    });
    expect(out).toEqual({
      headers: { "api-key": "[redacted]", authorization: "[redacted]", accept: "json" },
      nested: { githubToken: "[redacted]", dbPassword: "[redacted]", clientSecret: "[redacted]", runId: "r1" },
      list: [{ apiKey: "[redacted]" }],
    });
  });
});
