import { BrowserWindow, shell, nativeTheme, app } from "electron";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { is } from "@electron-toolkit/utils";
import { getConfig } from "./ipc/settings.ipc";
import { isOpenableExternalUrl, isAppNavigation } from "./utils/external-link";
import { createLogger } from "./services/logger";

const log = createLogger("window");

/** The URL itself is never logged — an email link can carry a tracking id. */
function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "unparseable";
  }
}

/**
 * Hand a link to the operating system's default handler — the only way any
 * URL that isn't the app itself is ever opened.
 */
function openExternally(url: string): void {
  if (!isOpenableExternalUrl(url)) {
    log.warn({ protocol: safeProtocol(url) }, "[Window] Refused to open a non-web link");
    return;
  }
  // A test run must never take over the developer's browser. The demo inbox
  // contains real-looking links and several e2e specs open those messages.
  if (isTestMode || useFakeData()) {
    log.info({ protocol: safeProtocol(url) }, "[Window] Suppressed external open in test mode");
    return;
  }
  shell.openExternal(url);
}

// __dirname is undefined in ESM. After the @anthropic-ai/claude-agent-sdk
// 0.3.x upgrade, electron-vite emits the main bundle as ESM, so we resolve
// the directory portably from import.meta.url.
const __dirname = dirname(fileURLToPath(import.meta.url));

export function getIconPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "icon.png");
  }
  return join(__dirname, "../../resources/icon.png");
}

let mainWindow: BrowserWindow | null = null;

// Check if running in test/headless mode
const isTestMode = process.env.NODE_ENV === "test" || process.env.EXO_HEADLESS === "true";

// Demo/test inboxes are fabricated, so their links point nowhere useful — and
// opening them means a test run reaches out of the sandbox onto the developer's
// desktop. Read lazily: the e2e harness sets these per launch.
const useFakeData = (): boolean =>
  process.env.EXO_TEST_MODE === "true" || process.env.EXO_DEMO_MODE === "true";

// Resolve initial background color from persisted theme to prevent white flash
function getInitialBackgroundColor(): string {
  try {
    const config = getConfig();
    const theme = config.theme || "system";
    const isDark = theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
    return isDark ? "#111827" : "#f3f4f6"; // gray-900 / gray-100
  } catch {
    return "#f3f4f6"; // default to light
  }
}

export function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: getInitialBackgroundColor(),
    icon: getIconPath(),
    // Prevent Chromium from throttling timers in hidden windows during tests.
    // Without this, setTimeout-based logic (e.g. undo-send toast auto-dismiss)
    // gets frozen indefinitely when the window is never shown.
    ...(isTestMode && { backgroundThrottling: false }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false, // ESM preload requires sandbox disabled
      contextIsolation: true,
      nodeIntegration: false,
      // Allow loading external images in emails
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    // Don't show window in test/headless mode
    if (!isTestMode) {
      mainWindow?.show();
    }
  });

  // Intercept keyboard shortcuts before they reach the page.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    // Cmd/Ctrl+F → open find bar
    const isFindModifier = process.platform === "darwin" ? input.meta : input.control;
    if (input.key === "f" && isFindModifier) {
      event.preventDefault();
      mainWindow?.webContents.send("find:open");
      return;
    }

    // Enter cycling is handled in the renderer (FindBar.tsx window-level
    // keydown listener) — before-input-event doesn't reliably fire for all
    // input methods (e.g. CDP key injection).
  });

  // Every link a sender puts in a message ends up in one of the two handlers
  // below, and neither ever lets it load inside the app.
  //
  // Email bodies render in a srcdoc iframe carrying `<base target="_blank">`,
  // so plain links arrive at the window-open handler. A sender can still
  // write target="_top" / "_self" (or submit a form, or redirect via script)
  // and steer the app window or the body iframe to their site — those are
  // navigations, not window opens, and land in will-frame-navigate instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-frame-navigate", (details) => {
    if (isAppNavigation(details.url, process.env["ELECTRON_RENDERER_URL"])) return;
    details.preventDefault();
    log.info(
      { protocol: safeProtocol(details.url), main_frame: details.isMainFrame },
      "[Window] Blocked in-app navigation, opening externally",
    );
    openExternally(details.url);
  });

  // HMR for renderer base on electron-vite cli
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
