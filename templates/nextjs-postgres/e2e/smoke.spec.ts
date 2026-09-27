import { expect, test } from "@playwright/test";

test("home page loads with one h1", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByRole("main")).toBeVisible();
});

test("health reports the database as ok", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { ok: boolean; db: string; version: string };
  expect(body).toMatchObject({ ok: true, db: "ok" });
  expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
});
