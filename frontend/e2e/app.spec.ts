import { expect, test } from "@playwright/test";
import { TERMS_VERSION } from "../src/lib/terms";

// Every flow test starts as a returning visitor: the one-time terms window is accepted
// up front so it never sits over the tab bar. The window has its own test below.
const ACCEPTED = JSON.stringify({ version: TERMS_VERSION, at: "2026-01-01T00:00:00.000Z" });
test.beforeEach(async ({ page }) => {
  // Init scripts run in order, so the two gate tests below can clear it again.
  await page.addInitScript((value) => window.localStorage.setItem("coattail.terms", value), ACCEPTED);
});

test("the terms window blocks a first visit until it is accepted, once", async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("gate-cleared")) {
      window.localStorage.removeItem("coattail.terms");
      window.sessionStorage.setItem("gate-cleared", "1");
    }
  });
  await page.goto("/");
  const gate = page.getByTestId("terms-gate");
  await expect(gate).toBeVisible();
  await expect(gate.getByRole("heading", { name: "Before you continue" })).toBeVisible();
  await expect(gate.getByText("Restricted Jurisdictions and Geographic Screening")).toBeVisible();
  const go = gate.getByRole("button", { name: "I agree, continue" });
  await expect(go).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(gate).toBeVisible();
  await gate.getByRole("checkbox").check();
  await go.click();
  await expect(gate).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: /Whatever Congress buys/ })).toBeVisible();
  await expect(page.getByTestId("terms-gate")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Terms", exact: true })).toBeVisible();
});

test("the terms page reads without the window and lists every section", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.removeItem("coattail.terms"));
  await page.goto("/terms");
  await expect(page.getByTestId("terms-gate")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Terms of use and disclosures" })).toBeVisible();
  for (const title of [
    "Website Disclaimer", "Stock Token Features", "Eligibility and Who May Use Stock Token Features",
    "Restricted Jurisdictions and Geographic Screening", "No Offer, No Advice",
    "Protocol and Smart Contracts (User Interface Only)", "Risk Disclosure",
    "Intellectual Property and NFT Art License", "Changes to Terms", "Governing Law and Jurisdiction",
  ]) await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
});

test("home and Activate render their live headings", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Whatever Congress buys/ })).toBeVisible();
  await page.getByRole("tab", { name: "My Brokers" }).click();
  await expect(page.getByRole("heading", { name: "My Brokers" })).toBeVisible();
});

test("Docs exposes tokenomics charts, randomness limits and two-NFT accounting", async ({ page }) => {
  await page.goto("/#docs");
  await page.getByRole("tab", { name: "Docs" }).click();
  await expect(page.getByRole("heading", { name: "Random IDs and fairness" })).toBeVisible();
  await expect(page.getByText(/timestamp alone is never used/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Owning multiple Brokers" })).toBeVisible();
  await expect(page.getByText(/73,500 COAT/)).toBeVisible();
  await expect(page.getByLabel("Tokenomics charts")).toBeVisible();
  await expect(page.getByText(/25k COAT/i)).toHaveCount(0);
});
