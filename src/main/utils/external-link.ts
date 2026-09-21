/**
 * Which URLs the app is willing to hand to the operating system.
 *
 * Email bodies are untrusted HTML rendered with `<base target="_blank">`, so
 * every link in every message a stranger sends ends up at the window-open
 * handler. shell.openExternal passes the string to the OS, which launches
 * whatever application has registered that scheme — so the set of things a
 * sender can make the machine do is the set of protocol handlers installed on
 * it, unless the app says otherwise. It says otherwise here.
 *
 * Parsed with the URL API rather than matched as a prefix: "https:/evil" and
 * " javascript:..." both defeat a startsWith check, and neither survives a
 * parse.
 */

/** mailto is included because composing a message is a reasonable thing for a link to do. */
export const OPENABLE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

export function isOpenableExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return OPENABLE_PROTOCOLS.has(parsed.protocol);
}

/**
 * Navigations the app performs on itself: the packaged renderer (file://),
 * the Vite dev server when one is set, and the blank / srcdoc documents its
 * iframes load. Any other navigation of the window or a frame is content
 * (an email body) trying to leave the app, and is opened externally instead.
 */
export function isAppNavigation(url: string, devServerUrl?: string): boolean {
  if (url === "about:blank" || url.startsWith("about:srcdoc")) return true;
  if (devServerUrl && url.startsWith(devServerUrl)) return true;
  return url.startsWith("file://");
}
