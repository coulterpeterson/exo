/**
 * Background learners fail where nobody is looking, so the one line they get
 * to show has to carry the useful part of the error.
 *
 * The case this was written for: a stale model pin returned a 503 whose top
 * `.message` was the raw JSON envelope, while the sentence naming the missing
 * model sat two levels down. Surfacing the envelope would have been almost as
 * useless as the silence it replaced.
 */
import { test, expect } from "@playwright/test";
import {
  describeLearningError,
  LEARNING_FEATURE_LABELS,
} from "../../src/main/utils/learning-failure";

test.describe("describeLearningError", () => {
  test("prefers the provider's innermost message over the JSON envelope", () => {
    const err = {
      status: 503,
      message: '503 {"type":"error","error":{"type":"api_error","message":"auth_unavailable"}}',
      error: {
        error: {
          message: "auth_unavailable: no auth available (providers=claude, model=claude-opus-4-6)",
        },
      },
    };
    const out = describeLearningError(err);
    expect(out).toBe(
      "503 — auth_unavailable: no auth available (providers=claude, model=claude-opus-4-6)",
    );
    // The model that failed is the actionable part — it names the dropdown to change.
    expect(out).toContain("claude-opus-4-6");
    expect(out).not.toContain('{"type"');
  });

  test("falls back to the top-level message when there is no nested error", () => {
    expect(describeLearningError({ status: 429, message: "rate limited" })).toBe(
      "429 — rate limited",
    );
  });

  test("omits the status prefix when there is no numeric status", () => {
    expect(describeLearningError(new Error("socket hang up"))).toBe("socket hang up");
  });

  test("survives a thrown non-object", () => {
    expect(describeLearningError("boom")).toBe("boom");
    expect(describeLearningError(null)).toBe("null");
  });

  test("truncates so one toast can't carry a whole stack trace", () => {
    const out = describeLearningError({ message: "x".repeat(5000) });
    expect(out.length).toBe(300);
  });

  test("every feature has a label, since the label is what the user reads", () => {
    expect(LEARNING_FEATURE_LABELS.style).toBe("Style learning");
    expect(LEARNING_FEATURE_LABELS.commitments).toBe("Commitment tracking");
  });
});
