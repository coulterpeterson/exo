/**
 * Health of the AI endpoint(s) the app depends on.
 *
 * Every analysis, draft and agent run goes through these endpoints, and when
 * one stops answering the failures are silent: jobs time out in the
 * background and mail quietly stops being sorted. A custom endpoint behind a
 * VPN (e.g. a proxy reached over Tailscale) is the common way to get there —
 * the VPN drops and nothing says so. The main process probes the endpoints
 * and the renderer shows a banner while any is failing.
 *
 * Shared so the renderer can render the status and the classifier can be
 * tested without Electron.
 */

export type LlmHealthProvider = "anthropic" | "ollama-cloud";

/** Why a probe failed — decides what the banner tells the user to check. */
export type LlmHealthFailureKind = "network" | "timeout" | "auth" | "endpoint";

export interface ProviderHealth {
  provider: LlmHealthProvider;
  /** The URL the app sends requests to, so the user can see which one is down. */
  endpoint: string;
  ok: boolean;
  kind?: LlmHealthFailureKind;
  /** Short technical detail, e.g. "ENETUNREACH" or "HTTP 502". */
  detail?: string;
  checkedAt: number;
}

export interface LlmHealthStatus {
  /** null until the first check has run. */
  checkedAt: number | null;
  providers: ProviderHealth[];
}

/** Errno codes that mean "the request never reached a server". */
const NETWORK_CODES = new Set([
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  code?: unknown;
  cause?: unknown;
}

function asErrorLike(value: unknown): ErrorLike | null {
  return typeof value === "object" && value !== null ? (value as ErrorLike) : null;
}

/** Walk the `cause` chain (the SDK wraps fetch errors, which wrap socket errors). */
function errorChain(error: unknown): ErrorLike[] {
  const chain: ErrorLike[] = [];
  let current = asErrorLike(error);
  while (current && chain.length < 6) {
    chain.push(current);
    current = asErrorLike(current.cause);
  }
  return chain;
}

function findErrnoCode(chain: ErrorLike[]): string | undefined {
  for (const e of chain) {
    if (typeof e.code === "string" && /^E[A-Z_]+$/.test(e.code)) return e.code;
    const match = typeof e.message === "string" ? e.message.match(/\b(E[A-Z]{4,})\b/) : null;
    if (match) return match[1];
  }
  return undefined;
}

export type ProbeOutcome = { ok: true } | { ok: false; kind: LlmHealthFailureKind; detail: string };

/**
 * Classify what a failed probe means.
 *
 * Mirrors the API-key validator in Settings: a 403, 429 or 529 means the
 * endpoint answered and accepted the key — it's rate-limiting or briefly
 * overloaded, which jobs already retry through — so it counts as healthy.
 * Anything else that comes back with a status is a broken endpoint (a proxy
 * whose upstream login expired typically answers 5xx), and an error with no
 * status never reached a server at all.
 */
export function classifyProbeError(error: unknown): ProbeOutcome {
  const chain = errorChain(error);
  const top = chain[0];
  const status = typeof top?.status === "number" ? top.status : undefined;

  if (status !== undefined) {
    if (status === 401) return { ok: false, kind: "auth", detail: "HTTP 401" };
    if (status === 403 || status === 429 || status === 529) return { ok: true };
    return { ok: false, kind: "endpoint", detail: `HTTP ${status}` };
  }

  const names = chain.map((e) => (typeof e.name === "string" ? e.name : ""));
  const messages = chain.map((e) => (typeof e.message === "string" ? e.message : ""));
  if (
    names.some((n) => /Timeout|AbortError/.test(n)) ||
    messages.some((m) => /timed out|aborted/i.test(m))
  ) {
    return { ok: false, kind: "timeout", detail: "timed out" };
  }

  const code = findErrnoCode(chain);
  if (
    (code && NETWORK_CODES.has(code)) ||
    names.some((n) => n === "APIConnectionError") ||
    messages.some((m) => /fetch failed|connection error/i.test(m))
  ) {
    return { ok: false, kind: "network", detail: code ?? "connection failed" };
  }

  return {
    ok: false,
    kind: "endpoint",
    detail: (messages[0] || "unknown error").slice(0, 120),
  };
}

const PROVIDER_LABELS: Record<LlmHealthProvider, string> = {
  anthropic: "Anthropic API",
  "ollama-cloud": "Ollama Cloud",
};

/** One-line explanation for the banner: what failed, and what to check. */
export function describeFailure(health: ProviderHealth): string {
  const where = `${PROVIDER_LABELS[health.provider]} (${health.endpoint})`;
  switch (health.kind) {
    case "network":
      return `Can't reach the ${where}${health.detail ? ` — ${health.detail}` : ""}. Check your VPN or network connection.`;
    case "timeout":
      return `The ${where} isn't responding — requests time out. Check your VPN, proxy, or network.`;
    case "auth":
      return `The ${where} rejected the API key. Check it in Settings.`;
    default:
      return `The ${where} is returning errors${health.detail ? ` (${health.detail})` : ""}. If it's a proxy, check that it's signed in upstream.`;
  }
}

export function failingProviders(status: LlmHealthStatus | null): ProviderHealth[] {
  return status ? status.providers.filter((p) => !p.ok) : [];
}
