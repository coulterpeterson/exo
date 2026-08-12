import { useEffect, useState } from "react";
import { useAppStore } from "../store";

interface LearnedCommitment {
  id: string;
  statement: string;
  startDate: string | null;
  endDate: string | null;
  counterpartyLabel: string | null;
  unconfirmed: boolean;
}

/**
 * Surfaces commitments recorded automatically from a sent email.
 *
 * Not decoration. Commitments are auto-saved and then steer future negotiation
 * drafts, so a silent write is the difference between a mistake you can correct
 * and one you never learn about. The toast links straight into the tab where it
 * can be edited or deleted.
 */
export function CommitmentsLearnedToast() {
  const [learned, setLearned] = useState<{ saved: LearnedCommitment[]; cancelled: number } | null>(
    null,
  );
  const setShowSettings = useAppStore((s) => s.setShowSettings);

  useEffect(() => {
    if (!window.api?.memory?.onCommitmentsLearned) return;
    return window.api.memory.onCommitmentsLearned(
      (data: { saved: LearnedCommitment[]; cancelled: number }) => setLearned(data),
    );
  }, []);

  useEffect(() => {
    if (!learned) return;
    const timer = setTimeout(() => setLearned(null), 9000);
    return () => clearTimeout(timer);
  }, [learned]);

  if (!learned || (learned.saved.length === 0 && learned.cancelled === 0)) return null;

  const first = learned.saved[0];
  const extra = learned.saved.length - 1;

  return (
    <div
      data-testid="commitments-learned-toast"
      className="fixed bottom-16 right-4 z-50 max-w-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg p-3"
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {first ? "Commitment remembered" : "Commitment cancelled"}
          </p>
          {first && (
            <p className="text-xs text-gray-600 dark:text-gray-300 mt-0.5">
              {first.startDate && (
                <span className="font-mono">
                  {first.startDate}
                  {first.endDate && first.endDate !== first.startDate
                    ? ` → ${first.endDate}`
                    : ""}{" "}
                </span>
              )}
              {first.counterpartyLabel ? `${first.counterpartyLabel} — ` : ""}
              {first.statement}
            </p>
          )}
          {extra > 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">and {extra} more</p>
          )}
          {first?.unconfirmed && (
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
              Low confidence — worth checking.
            </p>
          )}
          <button
            onClick={() => {
              setShowSettings(true, "commitments");
              setLearned(null);
            }}
            className="mt-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
          >
            Review
          </button>
        </div>
        <button
          onClick={() => setLearned(null)}
          aria-label="Dismiss"
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xs"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
