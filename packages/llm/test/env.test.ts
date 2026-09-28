/**
 * Table-driven tests for the two-value provider env parser (02 §1).
 * Protects: every documented rule, and that no key value ever reaches the report.
 */
import { describe, expect, it } from "vitest";
import { formatProviderTable, parseProviderEnv, parseTwoValue, type ProviderEntry, type ProviderKind } from "../src/env.js";

const KEY = "sk-secret-VALUE-123";

function entry(env: Record<string, string | undefined>, id: string, kind: ProviderKind = "llm"): ProviderEntry {
  const found = parseProviderEnv(env).providers.find((p) => p.id === id && p.kind === kind);
  if (!found) throw new Error(`no entry ${kind}:${id}`);
  return found;
}

describe("parseTwoValue", () => {
  it.each([
    ["true|abc", true, "abc"],
    ["TRUE|abc", true, "abc"],
    ["1|abc", true, "abc"],
    ["yes|abc", true, "abc"],
    ["On|abc", true, "abc"],
    ["  true  |  abc  ", true, "abc"],
    ["false|abc", false, "abc"],
    ["enabled|abc", false, "abc"],
    ["true|a|b", true, "a|b"],
    ["true", true, ""],
    ["true|", true, ""],
    ['"true|abc"', true, "abc"],
    ["", false, ""],
  ])("%j → enabled=%s key=%j", (raw, enabled, key) => {
    expect(parseTwoValue(raw)).toEqual({ enabled, key });
  });
});

describe("parseProviderEnv: status rules", () => {
  const cases: Array<{ name: string; env: Record<string, string>; id: string; kind?: ProviderKind; status: ProviderEntry["status"]; keyPresent: boolean; reason?: RegExp }> = [
    { name: "absent is disabled", env: {}, id: "anthropic", status: "disabled", keyPresent: false },
    { name: "combined true + key", env: { LLM_ANTHROPIC: `true|${KEY}` }, id: "anthropic", status: "enabled", keyPresent: true },
    { name: "combined false + empty", env: { LLM_OPENAI: "false|" }, id: "openai", status: "disabled", keyPresent: false },
    { name: "true + empty key is misconfigured", env: { LLM_ZAI: "true|" }, id: "zai", status: "misconfigured", keyPresent: false, reason: /enabled but has no API key/ },
    { name: "true + whitespace key is misconfigured", env: { LLM_ZAI: "true|   " }, id: "zai", status: "misconfigured", keyPresent: false },
    { name: "local ollama true + empty is enabled", env: { LLM_OLLAMA: "true|" }, id: "ollama", status: "enabled", keyPresent: false, reason: /local provider/ },
    { name: "local lmstudio", env: { LLM_LMSTUDIO: "yes" }, id: "lmstudio", status: "enabled", keyPresent: false },
    { name: "local vllm with key", env: { LLM_VLLM: `1|${KEY}` }, id: "vllm", status: "enabled", keyPresent: true },
    { name: "false + key is disabled with warning", env: { LLM_QWEN: `false|${KEY}` }, id: "qwen", status: "disabled", keyPresent: true, reason: /switched off but carries a key/ },
    { name: "separate form enabled", env: { LLM_GOOGLE_ENABLED: "true", LLM_GOOGLE_API_KEY: KEY }, id: "google", status: "enabled", keyPresent: true },
    { name: "separate form enabled without key", env: { LLM_GOOGLE_ENABLED: "on" }, id: "google", status: "misconfigured", keyPresent: false },
    { name: "separate key without switch is disabled", env: { LLM_GOOGLE_API_KEY: KEY }, id: "google", status: "disabled", keyPresent: true, reason: /switched off/ },
    { name: "both forms agreeing", env: { LLM_DEEPSEEK: `true|${KEY}`, LLM_DEEPSEEK_ENABLED: "true", LLM_DEEPSEEK_API_KEY: KEY }, id: "deepseek", status: "enabled", keyPresent: true },
    { name: "both forms: switch disagrees", env: { LLM_DEEPSEEK: `true|${KEY}`, LLM_DEEPSEEK_ENABLED: "false" }, id: "deepseek", status: "misconfigured", keyPresent: true, reason: /disagree/ },
    { name: "both forms: switch disagrees (off in combined)", env: { LLM_DEEPSEEK: `false|${KEY}`, LLM_DEEPSEEK_ENABLED: "true" }, id: "deepseek", status: "misconfigured", keyPresent: true, reason: /disagree/ },
    { name: "both forms: keys differ", env: { LLM_MISTRAL: `true|${KEY}`, LLM_MISTRAL_API_KEY: "other" }, id: "mistral", status: "misconfigured", keyPresent: true, reason: /different keys/ },
    { name: "both forms: key only in separate", env: { LLM_MISTRAL: "true|", LLM_MISTRAL_API_KEY: KEY }, id: "mistral", status: "misconfigured", keyPresent: true, reason: /different keys/ },
    { name: "image provider", env: { IMAGE_FAL: `true|${KEY}` }, id: "fal", kind: "image", status: "enabled", keyPresent: true },
    { name: "image openai is separate from llm openai", env: { IMAGE_OPENAI: "true|" }, id: "openai", kind: "image", status: "misconfigured", keyPresent: false },
    { name: "stock provider", env: { STOCK_PEXELS: `true|${KEY}` }, id: "pexels", kind: "stock", status: "enabled", keyPresent: true },
    { name: "stock separate form", env: { STOCK_UNSPLASH_ENABLED: "1", STOCK_UNSPLASH_API_KEY: KEY }, id: "unsplash", kind: "stock", status: "enabled", keyPresent: true },
  ];

  it.each(cases)("$name", ({ env, id, kind, status, keyPresent, reason }) => {
    const e = entry(env, id, kind ?? "llm");
    expect(e.status).toBe(status);
    expect(e.apiKeyPresent).toBe(keyPresent);
    if (reason) expect(e.reasons.join("\n")).toMatch(reason);
  });

  it("report.ok is false when anything is misconfigured", () => {
    expect(parseProviderEnv({ LLM_ANTHROPIC: `true|${KEY}` }).ok).toBe(true);
    expect(parseProviderEnv({ LLM_ANTHROPIC: `true|${KEY}`, LLM_ZAI: "true|" }).ok).toBe(false);
  });

  it("lists every known provider exactly once per kind", () => {
    const r = parseProviderEnv({});
    expect(r.providers.filter((p) => p.kind === "llm")).toHaveLength(18);
    expect(r.providers.filter((p) => p.kind === "image")).toHaveLength(5);
    expect(r.providers.filter((p) => p.kind === "stock")).toHaveLength(3);
  });
});

describe("parseProviderEnv: optional settings", () => {
  it("parses base url, org, timeout, concurrency and extra models", () => {
    const e = entry(
      {
        LLM_ZAI: `true|${KEY}`,
        LLM_ZAI_BASE_URL: "https://open.bigmodel.cn/api/paas/v4/",
        LLM_ZAI_ORG: "org-1",
        LLM_ZAI_TIMEOUT_MS: "60000",
        LLM_ZAI_MAX_CONCURRENCY: "4",
        LLM_ZAI_EXTRA_MODELS: '[{"id":"glm-x","contextTokens":200000,"maxOutputTokens":32000}]',
      },
      "zai",
    );
    expect(e.status).toBe("enabled");
    expect(e.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(e.org).toBe("org-1");
    expect(e.timeoutMs).toBe(60000);
    expect(e.maxConcurrency).toBe(4);
    expect(e.extraModels).toEqual([{ id: "glm-x", contextTokens: 200000, maxOutputTokens: 32000 }]);
  });

  it("strips credentials from the base url", () => {
    const e = entry({ LLM_OLLAMA: "true|", LLM_OLLAMA_BASE_URL: "http://user:pw@host.docker.internal:11434/v1" }, "ollama");
    expect(e.baseUrl).toBe("http://host.docker.internal:11434/v1");
    expect(JSON.stringify(e)).not.toContain("pw");
  });

  it.each([
    ["LLM_ANTHROPIC_EXTRA_MODELS", "not json", /not valid JSON/],
    ["LLM_ANTHROPIC_EXTRA_MODELS", '[{"id":"x"}]', /EXTRA_MODELS is invalid/],
    ["LLM_ANTHROPIC_EXTRA_MODELS", '[{"id":"x","contextTokens":1,"maxOutputTokens":1,"bogus":1}]', /EXTRA_MODELS is invalid/],
    ["LLM_ANTHROPIC_TIMEOUT_MS", "-5", /positive integer/],
    ["LLM_ANTHROPIC_MAX_CONCURRENCY", "two", /positive integer/],
    ["LLM_ANTHROPIC_BASE_URL", "not a url", /not a valid URL/],
    ["LLM_ANTHROPIC_BASE_URL", "ftp://x", /http\(s\)/],
  ])("invalid %s=%j makes an enabled provider misconfigured", (name, value, reason) => {
    const e = entry({ LLM_ANTHROPIC: `true|${KEY}`, [name]: value }, "anthropic");
    expect(e.status).toBe("misconfigured");
    expect(e.reasons.join("\n")).toMatch(reason);
  });

  it("invalid settings on a disabled provider only warn", () => {
    const e = entry({ LLM_ANTHROPIC: "false|", LLM_ANTHROPIC_TIMEOUT_MS: "x" }, "anthropic");
    expect(e.status).toBe("disabled");
    expect(e.reasons.join("\n")).toMatch(/warning: .*positive integer/);
  });

  it("reports unknown provider variables (typos)", () => {
    const r = parseProviderEnv({ LLM_ANTHROPC: "true|x", LLM_ANTHROPIC_BASE_URL: "https://a.b", STOCK_FLICKR: "true|x", PATH: "/bin" });
    expect(r.unknownVariables).toEqual(["LLM_ANTHROPC", "STOCK_FLICKR"]);
  });
});

describe("nvidia and request rate", () => {
  it("LLM_NVIDIA is a hosted provider: a key is required", () => {
    expect(entry({ LLM_NVIDIA: `true|${KEY}` }, "nvidia")).toMatchObject({ status: "enabled", local: false, apiKeyPresent: true });
    expect(entry({ LLM_NVIDIA: "true|" }, "nvidia").status).toBe("misconfigured");
  });

  it("parses LLM_<P>_RPM as a positive integer", () => {
    expect(entry({ LLM_NVIDIA: `true|${KEY}`, LLM_NVIDIA_RPM: "40" }, "nvidia").rpm).toBe(40);
    expect(entry({ LLM_NVIDIA: `true|${KEY}` }, "nvidia").rpm).toBeUndefined();
    const bad = entry({ LLM_NVIDIA: `true|${KEY}`, LLM_NVIDIA_RPM: "0" }, "nvidia");
    expect(bad.status).toBe("misconfigured");
    expect(bad.reasons.join("\n")).toMatch(/LLM_NVIDIA_RPM must be a positive integer/);
  });

  it("never reports IMAGES_FROM_WEB_SEARCH or LLM_<P>_RPM as unknown", () => {
    const r = parseProviderEnv({ IMAGES_FROM_WEB_SEARCH: "true", LLM_NVIDIA: `true|${KEY}`, LLM_NVIDIA_RPM: "40", LLM_GROQ_RPM: "30", LLM_NVIDA_RPM: "1" });
    expect(r.unknownVariables).toEqual(["LLM_NVIDA_RPM"]);
  });
});

describe("key secrecy", () => {
  const env = {
    LLM_ANTHROPIC: `true|${KEY}`,
    LLM_QWEN: `false|${KEY}-qwen`,
    LLM_DEEPSEEK: `true|${KEY}-ds`,
    LLM_DEEPSEEK_API_KEY: "different-SECRET",
    STOCK_PEXELS_ENABLED: "true",
    STOCK_PEXELS_API_KEY: `${KEY}-pexels`,
  };

  it("never serialises a key value", () => {
    const r = parseProviderEnv(env);
    const json = JSON.stringify(r);
    expect(json).not.toContain(KEY);
    expect(json).not.toContain("different-SECRET");
    expect(Object.keys(r)).not.toContain("getApiKey");
    const table = formatProviderTable(r);
    expect(table).not.toContain(KEY);
    expect(table).not.toContain("different-SECRET");
  });

  it("getApiKey returns keys only for enabled providers", () => {
    const r = parseProviderEnv(env);
    expect(r.getApiKey("anthropic")).toBe(KEY);
    expect(r.getApiKey("pexels", "stock")).toBe(`${KEY}-pexels`);
    expect(r.getApiKey("qwen")).toBeUndefined(); // disabled
    expect(r.getApiKey("deepseek")).toBeUndefined(); // misconfigured
    expect(r.getApiKey("pexels")).toBeUndefined(); // wrong kind
  });
});

describe("formatProviderTable", () => {
  it("prints status per provider and refuses when misconfigured", () => {
    const table = formatProviderTable(parseProviderEnv({ LLM_ANTHROPIC: `true|${KEY}`, LLM_OLLAMA: "true|", LLM_ZAI: "true|" }));
    expect(table).toMatch(/llm\s+anthropic\s+enabled\s+yes/);
    expect(table).toMatch(/llm\s+ollama\s+enabled\s+local/);
    expect(table).toMatch(/llm\s+zai\s+MISCONFIGURED/);
    expect(table).toContain("refusing to start");
  });

  it("can hide quiet disabled rows", () => {
    const table = formatProviderTable(parseProviderEnv({ LLM_ANTHROPIC: `true|${KEY}` }), { includeDisabled: false });
    expect(table).not.toMatch(/openai/);
  });
});
