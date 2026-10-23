/**
 * Watches the AI endpoints the app depends on and tells the renderer when one
 * stops answering, so a dropped VPN or an expired proxy login shows up as a
 * banner instead of as a day of silently failed analysis and drafts.
 *
 * Checks on launch and every 15 minutes. While anything is failing it checks
 * every minute instead, so the banner clears soon after the user fixes the
 * cause. Also re-checks when the network comes back and when AI settings
 * change.
 */
import { getMainWindow } from "../window";
import { getConfig, getFeatureModelConfig } from "../ipc/settings.ipc";
import { probeProvider, providerEndpoint } from "./llm-service";
import { networkMonitor } from "./network-monitor";
import { createLogger } from "./logger";
import { ModelConfigSchema, type LlmProvider } from "../../shared/types";
import {
  classifyProbeError,
  type LlmHealthStatus,
  type ProviderHealth,
} from "../../shared/llm-health";

const log = createLogger("llm-health");

const INTERVAL_MS = 15 * 60 * 1000;
/** While failing: check often enough that fixing the cause clears the banner quickly. */
const FAILING_RECHECK_MS = 60 * 1000;
/** Let startup finish (config, env, accounts) before the first probe. */
const STARTUP_DELAY_MS = 10 * 1000;
const PROBE_TIMEOUT_MS = 20 * 1000;

/**
 * Demo and test runs make no real AI calls, so there is nothing to check —
 * and a failing check would put the banner over every e2e screenshot.
 * EXO_FORCE_LLM_HEALTH_CHECK opts a demo/test run back in, which is how the
 * banner itself is tested (against a fake endpoint).
 */
const useFakeData = (): boolean =>
  process.env.EXO_FORCE_LLM_HEALTH_CHECK !== "true" &&
  (process.env.EXO_TEST_MODE === "true" ||
    process.env.EXO_DEMO_MODE === "true" ||
    process.env.NODE_ENV === "test");

/**
 * Each provider some feature is routed to, with a model to probe it with.
 * Probing with a model a feature actually uses matters: a proxy that only
 * serves some models would answer 400 to an arbitrary one and raise a false
 * alarm. The cheapest feature (sender lookup) is preferred when it qualifies.
 */
function providersInUse(): Array<{ provider: LlmProvider; model: string }> {
  const config = getConfig();
  const features = Object.keys(ModelConfigSchema.shape) as Array<
    keyof typeof ModelConfigSchema.shape
  >;
  const ordered = ["senderLookup" as const, ...features.filter((f) => f !== "senderLookup")];

  const byProvider = new Map<LlmProvider, string>();
  for (const feature of ordered) {
    const { provider, model } = getFeatureModelConfig(feature);
    if (!byProvider.has(provider)) byProvider.set(provider, model);
  }

  // A provider with no credentials isn't "down" — the user hasn't set it up,
  // and Settings / the setup wizard already say so.
  const configured = (provider: LlmProvider) =>
    provider === "ollama-cloud"
      ? Boolean(config.ollamaCloud?.apiKey)
      : Boolean(config.anthropicApiKey || process.env.ANTHROPIC_API_KEY);

  return [...byProvider.entries()]
    .filter(([provider]) => configured(provider))
    .map(([provider, model]) => ({ provider, model }));
}

class LlmHealthMonitor {
  private status: LlmHealthStatus = { checkedAt: null, providers: [] };
  private intervalTimer: NodeJS.Timeout | null = null;
  private recheckTimer: NodeJS.Timeout | null = null;
  private inflight: Promise<LlmHealthStatus> | null = null;
  private started = false;

  getStatus(): LlmHealthStatus {
    return this.status;
  }

  start(): void {
    if (this.started || useFakeData()) return;
    this.started = true;
    setTimeout(() => void this.checkNow(), STARTUP_DELAY_MS);
    this.intervalTimer = setInterval(() => void this.checkNow(), INTERVAL_MS);
    // Coming back online is exactly when a failing endpoint is likely to recover.
    networkMonitor.on("online", () => void this.checkNow());
  }

  stop(): void {
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.intervalTimer = null;
    this.recheckTimer = null;
  }

  /** Run a check now (deduplicated with one already running). */
  checkNow(): Promise<LlmHealthStatus> {
    if (useFakeData()) return Promise.resolve(this.status);
    this.inflight ??= this.runCheck().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async runCheck(): Promise<LlmHealthStatus> {
    if (this.recheckTimer) {
      clearTimeout(this.recheckTimer);
      this.recheckTimer = null;
    }

    // Offline: the offline banner already explains why nothing works, and a
    // probe would only report the same thing less clearly.
    if (!networkMonitor.isOnline) {
      this.publish({ checkedAt: Date.now(), providers: [] });
      return this.status;
    }

    let targets: Array<{ provider: LlmProvider; model: string }>;
    try {
      targets = providersInUse();
    } catch (err) {
      log.error({ err }, "[LlmHealth] Could not resolve providers to check");
      return this.status;
    }

    const results = await Promise.all(
      targets.map(async ({ provider, model }): Promise<ProviderHealth> => {
        const checkedAt = Date.now();
        let endpoint: string;
        try {
          endpoint = providerEndpoint(provider);
        } catch {
          endpoint = "(not configured)";
        }
        try {
          await probeProvider(provider, model, PROBE_TIMEOUT_MS);
          return { provider, endpoint, ok: true, checkedAt };
        } catch (err) {
          const outcome = classifyProbeError(err);
          if (outcome.ok) return { provider, endpoint, ok: true, checkedAt };
          return {
            provider,
            endpoint,
            ok: false,
            kind: outcome.kind,
            detail: outcome.detail,
            checkedAt,
          };
        }
      }),
    );

    this.publish({ checkedAt: Date.now(), providers: results });

    if (results.some((r) => !r.ok)) {
      this.recheckTimer = setTimeout(() => void this.checkNow(), FAILING_RECHECK_MS);
    }
    return this.status;
  }

  private publish(next: LlmHealthStatus): void {
    const wasFailing = new Set(this.status.providers.filter((p) => !p.ok).map((p) => p.provider));
    for (const p of next.providers) {
      if (!p.ok && !wasFailing.has(p.provider)) {
        log.warn(
          { provider: p.provider, endpoint: p.endpoint, kind: p.kind, detail: p.detail },
          "[LlmHealth] AI endpoint is failing",
        );
      } else if (p.ok && wasFailing.has(p.provider)) {
        log.info(
          { provider: p.provider, endpoint: p.endpoint },
          "[LlmHealth] AI endpoint recovered",
        );
      }
    }
    this.status = next;

    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send("llm-health:changed", next);
  }
}

export const llmHealthMonitor = new LlmHealthMonitor();
