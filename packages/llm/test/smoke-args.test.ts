/**
 * Smoke CLI argument parsing. Protects: it never runs without the explicit spend flag and
 * rejects anything it does not understand. (The CLI itself is never run by tests.)
 */
import { describe, expect, it } from "vitest";
import { parseSmokeArgs } from "../src/cli/smoke-args.js";

describe("parseSmokeArgs", () => {
  it("parses the full form", () => {
    expect(parseSmokeArgs(["--provider", "nvidia", "--model", "z-ai/glm-5.3", "--tools", "--env-file", "../../infra/.env", "--yes-spend-one-request"])).toEqual({
      ok: true,
      args: { provider: "nvidia", model: "z-ai/glm-5.3", tools: true, envFile: "../../infra/.env" },
    });
  });

  it("accepts --flag=value and a bare provider id", () => {
    expect(parseSmokeArgs(["nvidia", "--model=z-ai/glm-5.3-flash", "--yes-spend-one-request"])).toEqual({
      ok: true,
      args: { provider: "nvidia", model: "z-ai/glm-5.3-flash", tools: false },
    });
  });

  it("refuses without --yes-spend-one-request", () => {
    expect(parseSmokeArgs(["--provider", "nvidia", "--tools"])).toEqual({ ok: false, help: false, error: expect.stringMatching(/--yes-spend-one-request/) });
  });

  it.each([
    [[], /--provider is required/],
    [["--provider"], /needs a value/],
    [["--provider", "--tools"], /needs a value/],
    [["--provider", "nvidia", "--model", "--yes-spend-one-request"], /--model needs a value/],
    [["--provider", "nvidia", "--bogus", "--yes-spend-one-request"], /unknown argument --bogus/],
    [["--provider", "Bad_Id!", "--yes-spend-one-request"], /invalid provider id/],
    [["nvidia", "extra", "--yes-spend-one-request"], /unknown argument extra/],
  ])("rejects %j", (argv, error) => {
    const r = parseSmokeArgs(argv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(error);
  });

  it("--help wins", () => {
    expect(parseSmokeArgs(["--provider", "nvidia", "--help"])).toEqual({ ok: false, help: true });
  });
});
