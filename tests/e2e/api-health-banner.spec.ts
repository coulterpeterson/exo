import { test, expect, Page, ElectronApplication } from "@playwright/test";
import http from "http";
import type { AddressInfo } from "net";
import { launchElectronApp, closeApp } from "./launch-helpers";

/**
 * The AI connection banner, end to end: a real app instance, health checks
 * forced on (demo mode skips them by default), pointed at a fake Anthropic
 * endpoint whose answer the test controls.
 *
 * Motivating incident: a dropped VPN silently cut the app off from its API
 * proxy and three days of analysis failed in the background unnoticed.
 */
test.describe("AI connection health banner", () => {
  test.describe.configure({ mode: "serial" });

  let electronApp: ElectronApplication;
  let page: Page;
  let server: http.Server;
  let baseUrl: string;
  let responseStatus = 502;

  test.beforeAll(async ({}, testInfo) => {
    server = http.createServer((_req, res) => {
      if (responseStatus === 200) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "test",
            content: [{ type: "text", text: "p" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
        return;
      }
      res.writeHead(responseStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "test" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const result = await launchElectronApp({
      workerIndex: testInfo.workerIndex,
      extraEnv: { EXO_FORCE_LLM_HEALTH_CHECK: "true" },
    });
    electronApp = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    // Per-worker data dirs outlive this spec; don't leave a fake endpoint
    // configured for the next one. Blank clears both settings.
    if (page) {
      await page
        .evaluate(() => window.api.settings.set({ anthropicApiKey: "", anthropicBaseUrl: "" }))
        .catch(() => {});
    }
    if (electronApp) await closeApp(electronApp);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("no banner while no AI endpoint is configured", async () => {
    await expect(page.locator("[data-testid='api-health-banner']")).toHaveCount(0);
  });

  test("saving an endpoint that fails raises the banner with the reason", async () => {
    responseStatus = 502;
    await page.evaluate(
      (url) => window.api.settings.set({ anthropicApiKey: "sk-ant-test", anthropicBaseUrl: url }),
      baseUrl,
    );
    const banner = page.locator("[data-testid='api-health-banner']");
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(banner).toContainText("AI connection failing");
    await expect(banner).toContainText(baseUrl);
    await expect(banner).toContainText("HTTP 502");
  });

  test("a rejected key says so", async () => {
    responseStatus = 401;
    await page.locator("[data-testid='api-health-check-again']").click();
    await expect(page.locator("[data-testid='api-health-banner']")).toContainText(
      "rejected the API key",
      { timeout: 15000 },
    );
  });

  test("'Check again' clears the banner once the endpoint recovers", async () => {
    responseStatus = 200;
    await page.locator("[data-testid='api-health-check-again']").click();
    await expect(page.locator("[data-testid='api-health-banner']")).toHaveCount(0, {
      timeout: 15000,
    });
  });
});
