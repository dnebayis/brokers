import { expect, test } from "@playwright/test";

test("random mint and multi-Broker rules are visible in the live flows", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Mint a Broker" })).toBeVisible();
  await expect(page.getByText(/unique pseudo-random ID/i)).toBeVisible();
  await expect(page.getByText("Primary mint cap", { exact: true })).toBeVisible();
  await expect(page.getByText(/— \/ 2/)).toBeVisible();

  await page.getByRole("tab", { name: "Activate" }).click();
  await expect(page.getByRole("heading", { name: "Your Brokers" })).toBeVisible();
  await expect(page.getByText("Active shares", { exact: true })).toBeVisible();
  await expect(page.getByText("Claim-ready", { exact: true })).toBeVisible();
});

test("Docs exposes tokenomics charts, randomness limits and two-NFT accounting", async ({ page }) => {
  await page.goto("/#docs");
  await page.getByRole("tab", { name: "Docs" }).click();
  await expect(page.getByRole("heading", { name: "Random IDs and fairness" })).toBeVisible();
  await expect(page.getByText(/not mathematically manipulation-proof/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Owning multiple Brokers" })).toBeVisible();
  await expect(page.getByText(/73,500 COAT/)).toBeVisible();
  await expect(page.getByLabel("Tokenomics charts")).toBeVisible();
  await expect(page.getByText(/25k COAT/i)).toHaveCount(0);
});
