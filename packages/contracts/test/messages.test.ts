import { describe, expect, it } from "vitest";
import { AGENT_ROLES, RUN_STATUSES } from "../src/plan";
import {
  detectLanguage,
  en,
  es,
  gatesProgressMessage,
  phaseMessage,
  t,
  taskStartedMessage,
  type MessageKey,
} from "../src/messages";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("catalogues", () => {
  it("have the same keys and placeholders in every language", () => {
    const keys = Object.keys(en) as MessageKey[];
    expect(Object.keys(es).sort()).toEqual([...keys].sort());
    for (const key of keys) expect(placeholders(es[key])).toEqual(placeholders(en[key]));
  });

  it("never leak role names", () => {
    // Role names that are also plain words ("security", "brand", "database", "docs") are allowed.
    const plain = new Set(["security", "brand", "database", "docs"]);
    const roleWords = AGENT_ROLES.filter((r) => !plain.has(r));
    for (const text of [...Object.values(en), ...Object.values(es)]) {
      for (const role of roleWords) expect(text.toLowerCase()).not.toMatch(new RegExp(`\\b${role}\\b`));
    }
  });

  it("have a phase message for every run status", () => {
    for (const status of RUN_STATUSES) {
      expect(phaseMessage("en", status)).not.toMatch(/\{|phase\./);
      expect(phaseMessage("es", status)).not.toMatch(/\{|phase\./);
    }
  });
});

describe("t()", () => {
  it("renders the documented Spanish examples", () => {
    expect(t("es", "run.starting")).toBe("Analizando tu petición…");
    expect(taskStartedMessage("es", "frontend", "de producto")).toBe("Creando la página de producto");
    expect(taskStartedMessage("es", "designer")).toBe("Diseñando la identidad visual");
    expect(gatesProgressMessage("es", 6, 11)).toBe("Comprobando 6 de 11 verificaciones");
  });

  it("renders English", () => {
    expect(taskStartedMessage("en", "frontend", "Pricing")).toBe("Building the Pricing page");
    expect(taskStartedMessage("en", "frontend")).toBe("Building a page");
    expect(taskStartedMessage("en", "reviewer", "ignored")).toBe("Reviewing the code");
    expect(gatesProgressMessage("en", 1, 11)).toBe("Running check 1 of 11");
    expect(t("en", "run.budgetExhausted", { spent: 4.9, budget: 5, skipped: "the blog" })).toBe(
      "This run reached its budget (4.9 of 5 USD) before finishing. What was left out: the blog",
    );
    expect(t("es", "run.stoppedByUser")).toMatch(/^Detenido por el usuario/);
  });

  it("leaves a missing placeholder visible instead of crashing", () => {
    const params = {} as { cause: string };
    expect(t("en", "run.internalError", params)).toContain("{cause}");
  });
});

describe("detectLanguage", () => {
  it.each([
    ["Quiero una tienda online de velas artesanales con carrito", "es"],
    ["Pon el botón en azul", "es"],
    ["¿qué base de datos usa?", "es"],
    ["Build a CRM for my dental clinic with appointments", "en"],
    ["make the button blue", "en"],
    ["", "en"],
    ["CRM", "en"],
  ] as const)("%s → %s", (prompt, lang) => {
    expect(detectLanguage(prompt)).toBe(lang);
  });
});
