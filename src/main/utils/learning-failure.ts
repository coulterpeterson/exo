/**
 * Turns a thrown background-learner error into one line a user can act on.
 *
 * The learners run fire-and-forget after a send, so their failures never reach
 * a promise the UI is waiting on. A misconfigured model therefore failed on
 * every send and left no trace outside the daily log — which is how a stale
 * model pin survived unnoticed until someone read the logs.
 *
 * Dependency-free so it can be unit tested; the main-process caller owns the
 * once-per-session dedupe.
 */

/** Which background learner failed. Also the dedupe key. */
export type LearningFeature = "style" | "commitments";

export const LEARNING_FEATURE_LABELS: Record<LearningFeature, string> = {
  style: "Style learning",
  commitments: "Commitment tracking",
};

/** Longest message we forward. Provider errors can carry an entire stack. */
const MAX_MESSAGE_CHARS = 300;

interface ApiErrorish {
  status?: unknown;
  message?: unknown;
  error?: { error?: { message?: unknown } };
}

/**
 * Prefer the provider's innermost message: the Anthropic SDK's `.message` is
 * the raw JSON envelope, whereas `error.error.message` is the sentence that
 * names the actual problem (and, for auth failures, the model it tried).
 */
export function describeLearningError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as ApiErrorish;
    const inner = e.error?.error?.message;
    const text =
      typeof inner === "string" && inner
        ? inner
        : typeof e.message === "string" && e.message
          ? e.message
          : String(err);
    const status = typeof e.status === "number" ? `${e.status} — ` : "";
    return `${status}${text}`.slice(0, MAX_MESSAGE_CHARS);
  }
  return String(err).slice(0, MAX_MESSAGE_CHARS);
}
