import { useEffect, useState } from "react";

/**
 * Splits a URL so the host can be shown whole and stand out. A phishing host
 * is often long ("paypal.com.account-verify.example.ru") with its real domain
 * at the end, so it is the path, never the host, that gets cut off. Userinfo
 * stays in the dim prefix, so "https://paypal.com@evil.example" reads as a
 * link to evil.example.
 */
function splitUrl(url: string): { prefix: string; host: string; rest: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // mailto:, javascript: and the like have no host to single out
  if (!parsed.host) return null;
  const userinfo = parsed.username
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`
    : "";
  return {
    prefix: `${parsed.protocol}//${userinfo}`,
    host: parsed.host,
    rest: `${parsed.pathname}${parsed.search}${parsed.hash}`,
  };
}

/**
 * Where the hovered link actually goes, in the bottom-left corner like a
 * browser's status bubble, so a link can be checked before it's clicked.
 */
export function LinkStatusBar() {
  const [url, setUrl] = useState("");

  useEffect(() => window.api.links?.onHover(setUrl), []);

  if (!url) return null;
  const parts = splitUrl(url);

  return (
    <div
      className="fixed bottom-0 left-0 z-[60] max-w-[70vw] pointer-events-none flex items-baseline px-2 py-1 rounded-tr-md border-t border-r border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 text-xs text-gray-600 dark:text-gray-300 shadow-sm"
      data-testid="link-status-bar"
    >
      {parts ? (
        <>
          <span className="shrink-0">{parts.prefix}</span>
          <span className="shrink-0 max-w-full break-all font-semibold text-gray-900 dark:text-gray-100">
            {parts.host}
          </span>
          <span className="min-w-0 truncate">{parts.rest}</span>
        </>
      ) : (
        <span className="min-w-0 truncate">{url}</span>
      )}
    </div>
  );
}
