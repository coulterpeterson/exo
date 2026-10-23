import { useEffect, useState } from "react";
import type { IpcResponse } from "../../shared/types";
import { describeFailure, failingProviders, type LlmHealthStatus } from "../../shared/llm-health";

function minutesAgo(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  return minutes === 1 ? "1 min ago" : `${minutes} min ago`;
}

/**
 * Shown while an AI endpoint the app depends on is failing its health check
 * (see llm-health-monitor.ts). Deliberately loud: when the endpoint is down,
 * analysis, drafts and the agent all fail in the background, and nothing
 * else on screen says so.
 */
export function ApiHealthBanner() {
  const [status, setStatus] = useState<LlmHealthStatus | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.api.llmHealth
      ?.get()
      .then((response: IpcResponse<LlmHealthStatus>) => {
        if (!cancelled && response.success) setStatus(response.data);
      })
      .catch(() => {});
    const unsubscribe = window.api.llmHealth?.onChanged((next: LlmHealthStatus) => setStatus(next));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const failing = failingProviders(status);
  if (failing.length === 0) return null;

  const checkAgain = async () => {
    setChecking(true);
    try {
      const response = (await window.api.llmHealth.check()) as IpcResponse<LlmHealthStatus>;
      if (response.success) setStatus(response.data);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      role="alert"
      data-testid="api-health-banner"
      className="titlebar-drag bg-red-600 dark:bg-red-700 text-white pl-20 pr-4 py-2 flex items-start justify-between gap-4"
    >
      <div className="flex items-start gap-2 min-w-0">
        <svg
          className="w-5 h-5 mt-0.5 flex-shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
          />
        </svg>
        <div className="min-w-0 text-sm">
          <p className="font-semibold">
            AI connection failing — analysis, drafts and the agent can't run
          </p>
          {failing.map((health) => (
            <p key={health.provider} className="text-red-50">
              {describeFailure(health)}
            </p>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0 titlebar-no-drag">
        {status?.checkedAt && (
          <span className="text-xs text-red-100">Checked {minutesAgo(status.checkedAt)}</span>
        )}
        <button
          onClick={checkAgain}
          disabled={checking}
          data-testid="api-health-check-again"
          className="px-2.5 py-1 text-xs font-medium rounded-md bg-white/15 hover:bg-white/25 disabled:opacity-60"
        >
          {checking ? "Checking…" : "Check again"}
        </button>
      </div>
    </div>
  );
}
