import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError, err, isErr, isOk, ok } from "@/lib/result";
import { authorizeOwner, authorizeRole } from "@/modules/auth";

describe("Result", () => {
  it("wraps values and errors", () => {
    const good = ok(42);
    const bad = err(new NotFoundError());
    expect(isOk(good) && good.value).toBe(42);
    expect(isErr(bad) && bad.error.status).toBe(404);
  });
});

describe("authorisation rules", () => {
  const user = { id: "u1", email: "u@example.com", name: "U", role: "user" as const };
  const admin = { ...user, id: "a1", role: "admin" as const };

  it("refuses anonymous callers with 401", () => {
    const result = authorizeRole(null, "user");
    expect(!result.ok && result.error.status).toBe(401);
  });

  it("refuses a user where admin is required", () => {
    const result = authorizeRole(user, "admin");
    expect(!result.ok && result.error).toBeInstanceOf(ForbiddenError);
  });

  it("lets owners and admins through", () => {
    expect(authorizeOwner(user, "u1").ok).toBe(true);
    expect(authorizeOwner(admin, "u1").ok).toBe(true);
    expect(authorizeOwner(user, "someone-else").ok).toBe(false);
  });
});
