import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ENGINE = "http://127.0.0.1:4177";
const TOKEN = "e2e-pairing-token";

function fixtureTarget(): string {
  const dirs = fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith("punch-e2e-"))
    .map((name) => path.join(os.tmpdir(), name, "fixture"))
    .filter((dir) => fs.existsSync(dir))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const dir = dirs[0];
  if (!dir) throw new Error("engine harness fixture not found");
  return `fixture:${dir}`;
}

async function pair(page: Page): Promise<void> {
  await page.goto("/console");
  await expect(page.getByRole("form", { name: "pair with engine" })).toBeVisible();
  // Unpaired: the pairing strip stands alone.
  await expect(page.getByTestId("controls-tile")).toHaveCount(0);
  await page.getByPlaceholder("http://localhost:4141").fill(ENGINE);
  await page.getByPlaceholder("pairing token").fill(TOKEN);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByTestId("pairing-strip")).toContainText("paired");
  await expect(page.getByTestId("config-chip")).toContainText(
    "config valid · 3 agents · 2 providers",
  );
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("pair, run, kill, watch takeover, deny approval", async ({ page }) => {
  await pair(page);
  await page.screenshot({ path: "e2e/screenshots/console-paired.png", fullPage: true });

  // Reload keeps the pairing (stored in the browser).
  await page.reload();
  await expect(page.getByTestId("pairing-strip")).toContainText("paired");

  await page.getByLabel("repo").fill(fixtureTarget());
  await page.getByRole("button", { name: "Run", exact: true }).click();

  const kill = page.getByRole("button", { name: "Kill researcher" });
  await expect(kill).toBeEnabled({ timeout: 15_000 });
  await kill.click();
  await expect(page.getByRole("log", { name: "conversation" })).toContainText(
    "You killed the researcher",
  );
  await expect(page.getByRole("log", { name: "conversation" })).toContainText(
    "took over the researcher",
    {
      timeout: 15_000,
    },
  );
  await expect(page.getByTestId("slot-researcher")).toContainText("replaced");

  // The same run on the watch board shows the takeover.
  const watchLink = page.getByRole("link", { name: "Open this run on the watch board" });
  const watchPage = await page.context().newPage();
  await watchPage.goto((await watchLink.getAttribute("href"))!);
  await expect(watchPage.getByText(/took over|takeover/i).first()).toBeVisible({ timeout: 20_000 });
  await watchPage.close();

  // Approval pauses the run on the exact payload; deny it.
  const approval = page.getByTestId("approval-tile");
  await expect(approval).toHaveAttribute("data-pending", "true", { timeout: 40_000 });
  await expect(page.getByTestId("approval-payload")).toContainText(
    "Security: fixture approval probe",
  );
  await page.screenshot({ path: "e2e/screenshots/console-approval.png", fullPage: true });
  await approval.getByRole("button", { name: "Deny" }).click();
  await expect(approval).toHaveAttribute("data-pending", "false");
  await expect(approval).toContainText("denied");
  await expect(page.getByRole("log", { name: "conversation" })).toContainText("No write made");
  await noHorizontalScroll(page);
});

test("manual mode runs the reference task with explicit assignments", async ({ page }) => {
  await pair(page);
  await page.getByRole("button", { name: "Manual", exact: true }).click();
  await expect(page.getByTestId("manual-tile")).toBeVisible();
  await page.getByLabel("repo").fill(fixtureTarget());
  await page.getByRole("button", { name: "Run with these assignments" }).click();
  await expect(page.getByRole("log", { name: "conversation" })).toContainText("in manual mode", {
    timeout: 15_000,
  });
  const approval = page.getByTestId("approval-tile");
  await expect(approval).toHaveAttribute("data-pending", "true", { timeout: 40_000 });
  await approval.getByRole("button", { name: "Deny" }).click();
  await expect(approval).toHaveAttribute("data-pending", "false");
  await page.screenshot({ path: "e2e/screenshots/console-manual.png", fullPage: true });
  await page.getByRole("button", { name: "Auto", exact: true }).click();
  await expect(page.getByTestId("manual-tile")).toHaveCount(0);
});

test.describe("390px phone viewport", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });

  test("pending approval fits without horizontal scroll", async ({ page }) => {
    await pair(page);
    await noHorizontalScroll(page);
    await page.getByLabel("repo").fill(fixtureTarget());
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const approval = page.getByTestId("approval-tile");
    await expect(approval).toHaveAttribute("data-pending", "true", { timeout: 40_000 });
    await noHorizontalScroll(page);
    await page.screenshot({ path: "e2e/screenshots/console-mobile.png", fullPage: true });
    await approval.getByRole("button", { name: "Deny" }).click();
    await expect(approval).toHaveAttribute("data-pending", "false");
  });
});
