import { describe, expect, it } from "vitest";
import {
  RESERVED_PROJECT_IDS,
  isReservedProjectId,
  isRoutableProjectSlug,
  isValidProjectSlug,
  validateProjectSlug,
} from "../src/slug";

describe("creation rules", () => {
  it.each([
    ["velas-artesanas", null],
    ["crm1", null],
    ["", "empty"],
    ["abc", "too-short"],
    ["a".repeat(36), "too-long"],
    ["a".repeat(35), null],
    ["My-App", "invalid-format"],
    ["1app", "invalid-format"],
    ["my--app", "invalid-format"],
    ["my-app-", "invalid-format"],
    ["my_app", "invalid-format"],
    ["shop-dev-one", "reserved"],
  ] as const)("%s → %s", (slug, problem) => {
    expect(validateProjectSlug(slug)).toBe(problem);
    expect(isValidProjectSlug(slug)).toBe(problem === null);
  });
});

describe("read rules", () => {
  it("routes ids that creation would refuse", () => {
    expect(isRoutableProjectSlug("deep-investigate-on-internet111testdev")).toBe(true);
    expect(isRoutableProjectSlug("francesc-test-dev-tesstttt")).toBe(true);
    expect(isRoutableProjectSlug("a".repeat(63))).toBe(true);
    expect(isRoutableProjectSlug("a".repeat(64))).toBe(false);
    expect(isRoutableProjectSlug("../etc")).toBe(false);
  });
});

describe("reserved ids", () => {
  it("covers the platform subdomains", () => {
    for (const id of ["apps", "www", "traefik", "engine", "api", "preview", "forja", "admin", "static"]) {
      expect(isReservedProjectId(id)).toBe(true);
    }
    expect(isReservedProjectId("Admin")).toBe(true);
    expect(isReservedProjectId("velas-artesanas")).toBe(false);
    expect(RESERVED_PROJECT_IDS.size).toBe(26);
  });
});
