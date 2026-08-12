import type { ConflictAvoided } from "../../shared/types";

/**
 * Renders what the pipeline did about a date collision.
 *
 * Deliberately driven off structured data rather than the agent's prose. The
 * summary in the agent panel is emergent model text — nothing in the app asks
 * for it, and a user-customised drafter prompt can change it entirely — so
 * relying on the model to mention an avoided conflict would work until it
 * quietly didn't. This card always renders when a conflict was computed.
 *
 * The wording follows `outcome`, never the other way round: "avoided" is only
 * shown when the pipeline steered the draft away AND the finished body was
 * verified not to mention the window.
 */
export function ConflictNotice({ conflicts }: { conflicts: ConflictAvoided[] }) {
  if (conflicts.length === 0) return null;

  return (
    <div className="space-y-1.5" data-testid="conflict-notice">
      {conflicts.map((c) => {
        const avoided = c.outcome === "avoided";
        return (
          <div
            key={`${c.commitmentId}-${c.outcome}`}
            className={`rounded-lg border px-3 py-2 text-xs ${
              avoided
                ? "border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/25 text-amber-900 dark:text-amber-200"
                : "border-orange-300 dark:border-orange-800 bg-orange-50 dark:bg-orange-900/25 text-orange-900 dark:text-orange-200"
            }`}
          >
            <div className="font-medium">
              {avoided ? "Avoided a date conflict" : "Possible date conflict"}
            </div>
            <p className="mt-0.5 leading-relaxed">
              {avoided ? (
                <>
                  <span className="font-mono">{fmt(c.blockedRange)}</span> is committed to{" "}
                  {c.counterpartyLabel}
                  {c.proposedRange ? (
                    <>
                      , so the draft pitches{" "}
                      <span className="font-mono">{fmt(c.proposedRange)}</span> instead.
                    </>
                  ) : (
                    <>, so the draft asks for other timing instead.</>
                  )}
                </>
              ) : (
                c.reason
              )}
              {c.unconfirmed && (
                <span className="opacity-80">
                  {" "}
                  This commitment was extracted automatically and hasn&apos;t been confirmed.
                </span>
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function fmt(range: { start: string | null; end: string | null }): string {
  if (!range.start && !range.end) return "unspecified dates";
  if (!range.end) return `from ${range.start}`;
  if (!range.start) return `until ${range.end}`;
  return range.start === range.end ? range.start : `${range.start} → ${range.end}`;
}
