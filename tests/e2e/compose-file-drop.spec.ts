import { test, expect, Page, ElectronApplication, CDPSession, Locator } from "@playwright/test";
import fs from "fs";
import path from "path";
import { launchElectronApp, closeApp } from "./launch-helpers";

/**
 * Dragging files from the desktop onto a compose form attaches them.
 *
 * The drag is dispatched through CDP (Input.dispatchDragEvent) with real paths
 * on disk, the same way an OS drag reaches Chromium. A DataTransfer built in
 * page script would carry File objects with no path behind them, which is
 * precisely the part (webUtils.getPathForFile) this needs to exercise.
 */

let electronApp: ElectronApplication;
let page: Page;
let cdp: CDPSession;

/** CDP drags land at viewport coordinates and, unlike a click, don't scroll. */
async function centerOf(target: Locator): Promise<{ x: number; y: number }> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("drop target has no bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dragFiles(
  type: "dragEnter" | "dragOver" | "drop",
  at: { x: number; y: number },
  files: string[],
): Promise<void> {
  await cdp.send("Input.dispatchDragEvent", {
    type,
    x: at.x,
    y: at.y,
    data: { items: [], files, dragOperationsMask: 1 },
  });
}

test.describe("Compose file drop", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;
    cdp = await page.context().newCDPSession(page);
  });

  test.afterAll(async () => {
    if (electronApp) await closeApp(electronApp);
  });

  test("files dropped on an inline reply become attachments, images included", async ({}, testInfo) => {
    const notes = testInfo.outputPath("meeting-notes.txt");
    const image = testInfo.outputPath("mockup.png");
    fs.mkdirSync(path.dirname(notes), { recursive: true });
    fs.writeFileSync(notes, "agenda");
    // 1x1 transparent PNG
    fs.writeFileSync(
      image,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        "base64",
      ),
    );

    const email = page.locator("button").filter({ hasText: "Q3 Quarterly Report" }).first();
    await expect(email).toBeVisible({ timeout: 15000 });
    await email.click();
    await page.keyboard.press("Enter");
    await page.locator("button[aria-label='Reply All']").first().click();
    const compose = page.locator("[data-testid='inline-compose']");
    await expect(compose.locator(".ProseMirror")).toBeVisible({ timeout: 5000 });

    // Over the editor itself: without the overlay, the editor would inline the image.
    const at = await centerOf(compose.locator(".ProseMirror"));
    const files = [notes, image];

    await dragFiles("dragEnter", at, files);
    await dragFiles("dragOver", at, files);
    await expect(compose.locator("[data-testid='compose-file-drop-zone']")).toBeVisible();

    await dragFiles("drop", at, files);
    await expect(compose.locator("[data-testid='compose-file-drop-zone']")).toHaveCount(0);
    await expect(compose.getByText("meeting-notes.txt", { exact: true })).toBeVisible();
    await expect(compose.getByText("mockup.png", { exact: true })).toBeVisible();
    await expect(compose.locator(".ProseMirror img")).toHaveCount(0);
  });

  test("a dropped folder is skipped, its sibling file still attaches", async ({}, testInfo) => {
    const folder = testInfo.outputPath("a-folder");
    const file = testInfo.outputPath("budget.csv");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(file, "a,b\n1,2\n");

    const compose = page.locator("[data-testid='inline-compose']");
    const at = await centerOf(compose.locator(".ProseMirror"));

    await dragFiles("dragEnter", at, [folder, file]);
    await dragFiles("dragOver", at, [folder, file]);
    await dragFiles("drop", at, [folder, file]);

    await expect(compose.getByText("budget.csv", { exact: true })).toBeVisible();
    await expect(compose.getByText("a-folder", { exact: true })).toHaveCount(0);
  });
});
