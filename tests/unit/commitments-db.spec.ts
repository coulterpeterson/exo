/**
 * SQL semantics for the commitments store.
 *
 * db/index.ts imports Electron and can't be loaded here, so — following the
 * approach in database.spec.ts — the exact queries the exported functions use
 * are run against an in-memory DB built from the real SCHEMA. What's under test
 * is the date filtering: getting it wrong either leaks an expired window into
 * every draft prompt, or drops a live one and lets the user double-book.
 */
import { test, expect } from "@playwright/test";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";
import { SCHEMA } from "../../src/main/db/schema";

const require = createRequire(import.meta.url);
type DB = BetterSqlite3.Database;

let DatabaseCtor: (new (filename: string | Buffer, options?: BetterSqlite3.Options) => DB) | null =
  null;
let nativeModuleError: string | null = null;
try {
  DatabaseCtor = require("better-sqlite3");
  const probe = new DatabaseCtor!(":memory:");
  probe.close();
} catch (e: unknown) {
  const err = e as Error;
  if (
    err.message?.includes("NODE_MODULE_VERSION") ||
    err.message?.includes("did not self-register")
  ) {
    nativeModuleError = err.message.split("\n")[0];
  } else {
    throw e;
  }
}

// Verbatim from db/index.ts getActiveCommitments.
const ACTIVE_SQL = `SELECT * FROM commitments
   WHERE account_id = ? AND status = 'active'
     AND COALESCE(end_date, '9999-12-31') >= ?
   ORDER BY COALESCE(start_date, '0000-01-01') ASC`;

// Verbatim from db/index.ts getCommitmentsInRange.
const RANGE_SQL = `SELECT * FROM commitments
   WHERE account_id = ? AND status = 'active'
     AND COALESCE(start_date, '0000-01-01') <= ?
     AND COALESCE(end_date,   '9999-12-31') >= ?
   ORDER BY COALESCE(start_date, '0000-01-01') ASC`;

function seed(db: DB, rows: Array<Record<string, unknown>>): void {
  const stmt = db.prepare(
    `INSERT INTO commitments (id, account_id, kind, status, statement, start_date, end_date,
      date_precision, exclusive, confidence, confirmed, source, created_at, updated_at)
     VALUES (@id, @account_id, @kind, @status, @statement, @start_date, @end_date,
      @date_precision, @exclusive, @confidence, @confirmed, @source, 0, 0)`,
  );
  for (const r of rows) {
    stmt.run({
      account_id: "default",
      kind: "date_range",
      status: "active",
      statement: "x",
      start_date: null,
      end_date: null,
      date_precision: "exact",
      exclusive: 1,
      confidence: 1,
      confirmed: 1,
      source: "manual",
      ...r,
    });
  }
}

test.describe("commitments SQL", () => {
  test.skip(!!nativeModuleError, `Skipping: ${nativeModuleError}`);

  let db: DB;

  test.beforeEach(() => {
    db = new DatabaseCtor!(":memory:");
    db.exec(SCHEMA);
  });

  test.afterEach(() => db?.close());

  test("SCHEMA creates the commitments table", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='commitments'")
      .get();
    expect(row).toBeTruthy();
  });

  test("active excludes windows that already closed", () => {
    seed(db, [
      { id: "past", start_date: "2026-01-01", end_date: "2026-01-31" },
      { id: "live", start_date: "2026-03-01", end_date: "2026-03-31" },
    ]);
    const ids = (db.prepare(ACTIVE_SQL).all("default", "2026-02-15") as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(ids).toEqual(["live"]);
  });

  test("a window ending today is still active", () => {
    // Boundary: the last day of a promised window is still promised.
    seed(db, [{ id: "today", start_date: "2026-02-01", end_date: "2026-02-15" }]);
    expect(db.prepare(ACTIVE_SQL).all("default", "2026-02-15")).toHaveLength(1);
  });

  test("an open-ended commitment never expires", () => {
    seed(db, [{ id: "open", start_date: "2020-01-01", end_date: null }]);
    expect(db.prepare(ACTIVE_SQL).all("default", "2099-01-01")).toHaveLength(1);
  });

  test("a dateless fact is always active", () => {
    // A declined deal has no window but is still worth telling the model.
    seed(db, [{ id: "fact", kind: "deal_declined", exclusive: 0 }]);
    expect(db.prepare(ACTIVE_SQL).all("default", "2026-02-15")).toHaveLength(1);
  });

  test("superseded and cancelled rows are excluded", () => {
    seed(db, [
      { id: "old", status: "superseded", start_date: "2026-03-01", end_date: "2026-03-31" },
      { id: "gone", status: "cancelled", start_date: "2026-03-01", end_date: "2026-03-31" },
      { id: "live", status: "active", start_date: "2026-03-01", end_date: "2026-03-31" },
    ]);
    const ids = (db.prepare(ACTIVE_SQL).all("default", "2026-02-01") as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(ids).toEqual(["live"]);
  });

  test("another account's commitments never leak in", () => {
    // A personal account must not inherit business exclusivity.
    seed(db, [
      { id: "mine", start_date: "2026-03-01", end_date: "2026-03-31" },
      { id: "theirs", account_id: "work", start_date: "2026-03-01", end_date: "2026-03-31" },
    ]);
    const ids = (db.prepare(ACTIVE_SQL).all("default", "2026-02-01") as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(ids).toEqual(["mine"]);
  });

  test("results are ordered by start date, dateless first", () => {
    seed(db, [
      { id: "b", start_date: "2026-05-01", end_date: "2026-05-10" },
      { id: "a", start_date: "2026-03-01", end_date: "2026-03-10" },
      { id: "none", start_date: null, end_date: null },
    ]);
    const ids = (db.prepare(ACTIVE_SQL).all("default", "2026-01-01") as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(ids).toEqual(["none", "a", "b"]);
  });

  test("range query matches overlaps, not containment", () => {
    seed(db, [
      { id: "before", start_date: "2026-01-01", end_date: "2026-01-31" },
      { id: "straddles-start", start_date: "2026-02-20", end_date: "2026-03-05" },
      { id: "inside", start_date: "2026-03-10", end_date: "2026-03-12" },
      { id: "straddles-end", start_date: "2026-03-28", end_date: "2026-04-10" },
      { id: "after", start_date: "2026-05-01", end_date: "2026-05-31" },
    ]);
    const ids = (
      db.prepare(RANGE_SQL).all("default", "2026-03-31", "2026-03-01") as Array<{ id: string }>
    ).map((r) => r.id);
    expect(ids).toEqual(["straddles-start", "inside", "straddles-end"]);
  });

  test("range query treats touching ranges as overlapping", () => {
    // Inclusive ends, matching rangesOverlap in utils/date-range.ts.
    seed(db, [{ id: "touch", start_date: "2026-03-31", end_date: "2026-04-05" }]);
    expect(db.prepare(RANGE_SQL).all("default", "2026-03-31", "2026-03-01")).toHaveLength(1);
    expect(db.prepare(RANGE_SQL).all("default", "2026-03-30", "2026-03-01")).toHaveLength(0);
  });
});
