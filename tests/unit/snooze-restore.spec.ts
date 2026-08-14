/**
 * The wake-up ordering rule.
 *
 * Snooze now archives the thread and files it under Exo/Snoozed, which means
 * the local row is the only thing that knows it should come back. Every test
 * here is really the same assertion from a different angle: a row outlives a
 * failed restore, because dropping it loses the mail.
 */
import { test, expect } from "@playwright/test";
import { restoreDueSnoozes, type DueSnooze } from "../../src/main/utils/snooze-restore";

const due = (id: string): DueSnooze => ({ id, threadId: `t-${id}`, accountId: "default" });

test.describe("restoreDueSnoozes", () => {
  test("removes a row only after the restore resolves", async () => {
    const order: string[] = [];
    const removed: string[] = [];
    const restored = await restoreDueSnoozes(
      [due("a")],
      async () => {
        order.push("restore");
      },
      (id) => {
        order.push("remove");
        removed.push(id);
      },
      () => {},
    );
    expect(order).toEqual(["restore", "remove"]);
    expect(removed).toEqual(["a"]);
    expect(restored.map((r) => r.id)).toEqual(["a"]);
  });

  test("keeps the row when Gmail fails, so the next tick retries", async () => {
    const removed: string[] = [];
    const errors: unknown[] = [];
    const restored = await restoreDueSnoozes(
      [due("a")],
      async () => {
        throw new Error("503");
      },
      (id) => removed.push(id),
      (err) => errors.push(err),
    );
    // The whole point: nothing deleted, so the thread is still tracked.
    expect(removed).toEqual([]);
    expect(restored).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  test("one failure does not block the rest of the batch", async () => {
    const removed: string[] = [];
    const restored = await restoreDueSnoozes(
      [due("a"), due("b"), due("c")],
      async (threadId) => {
        if (threadId === "t-b") throw new Error("boom");
      },
      (id) => removed.push(id),
      () => {},
    );
    expect(removed).toEqual(["a", "c"]);
    expect(restored.map((r) => r.id)).toEqual(["a", "c"]);
  });

  test("a failed row is retried on the next call and can then succeed", async () => {
    const removed: string[] = [];
    let failing = true;
    const restore = async () => {
      if (failing) throw new Error("offline");
    };
    const first = await restoreDueSnoozes(
      [due("a")],
      restore,
      (id) => removed.push(id),
      () => {},
    );
    expect(first).toEqual([]);

    failing = false;
    const second = await restoreDueSnoozes(
      [due("a")],
      restore,
      (id) => removed.push(id),
      () => {},
    );
    expect(second.map((r) => r.id)).toEqual(["a"]);
    expect(removed).toEqual(["a"]);
  });

  test("with no gateway every row is dropped — the original local-only behaviour", async () => {
    // Demo and e2e runs have no Gmail behind them and must keep working.
    const removed: string[] = [];
    const restored = await restoreDueSnoozes(
      [due("a"), due("b")],
      null,
      (id) => removed.push(id),
      () => {},
    );
    expect(removed).toEqual(["a", "b"]);
    expect(restored).toHaveLength(2);
  });

  test("restores are sequential, not concurrent", async () => {
    // Gmail is rate limited and a wake-up batch can be large; overlapping
    // batchModify calls are how a restore storm turns into 429s.
    let inFlight = 0;
    let maxInFlight = 0;
    await restoreDueSnoozes(
      [due("a"), due("b"), due("c")],
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      },
      () => {},
      () => {},
    );
    expect(maxInFlight).toBe(1);
  });

  test("an empty batch is a no-op", async () => {
    expect(
      await restoreDueSnoozes(
        [],
        null,
        () => {},
        () => {},
      ),
    ).toEqual([]);
  });
});
