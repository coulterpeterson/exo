import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp, closeApp } from "./launch-helpers";

/**
 * Hovering a link in a message shows where it really goes, in a status bar
 * fed by Chromium's own hover reporting (webContents "update-target-url"),
 * so these tests use real mouse movement over the email-body iframe.
 */

let electronApp: ElectronApplication;
let page: Page;

test.describe("Link status bar", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    const email = page.locator("button").filter({ hasText: "Q3 Quarterly Report" }).first();
    await expect(email).toBeVisible({ timeout: 15000 });
    await email.click();
    await expect(page.locator("iframe[title='Email content']").first()).toBeVisible({
      timeout: 5000,
    });
  });

  test.afterAll(async () => {
    if (electronApp) await closeApp(electronApp);
  });

  const body = () => page.frameLocator("iframe[title='Email content']").first();
  const statusBar = () => page.locator("[data-testid='link-status-bar']");

  test("shows the hovered link's destination and clears when the mouse leaves", async () => {
    await expect(statusBar()).toHaveCount(0);

    await body().locator("a", { hasText: "Q3 Report Dashboard" }).hover();
    await expect(statusBar()).toHaveText("https://dashboard.example.com/q3-report");
    await expect(statusBar().locator(".font-semibold")).toHaveText("dashboard.example.com");

    await page.mouse.move(5, 5);
    await expect(statusBar()).toHaveCount(0);
  });

  test("shows a lookalike Unicode host in punycode and the real host after userinfo", async () => {
    await body()
      .locator("body")
      .evaluate((el) => {
        // Cyrillic "а" in place of the Latin "a"
        el.insertAdjacentHTML(
          "afterbegin",
          '<p><a id="lookalike" href="https://аpple.com/login">apple.com</a></p>' +
            '<p><a id="userinfo" href="https://paypal.com@evil.example/x">paypal.com</a></p>',
        );
      });

    await body().locator("#lookalike").hover();
    await expect(statusBar().locator(".font-semibold")).toHaveText("xn--pple-43d.com");

    await body().locator("#userinfo").hover();
    await expect(statusBar()).toHaveText("https://paypal.com@evil.example/x");
    await expect(statusBar().locator(".font-semibold")).toHaveText("evil.example");
  });
});
