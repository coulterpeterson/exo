/**
 * The dock badge query (src/main/db/unread-count.ts), run against a real
 * in-memory database built from the app's own schema — the db module itself
 * imports electron, so the SQL lives apart from it for exactly this reason.
 *
 * A badge that counts the wrong thing is worse than no badge: it either nags
 * about mail that isn't there or stays silent about mail that is.
 */
import { test, expect } from "@playwright/test";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";
import { SCHEMA } from "../../src/main/db/schema";
import { unreadThreadCountSql } from "../../src/main/db/unread-count";

const require = createRequire(import.meta.url);

type DB = BetterSqlite3.Database;

// better-sqlite3 may be compiled for Electron's ABI rather than system Node.
let DatabaseCtor: (new (filename: string) => DB) | null = null;
let nativeModuleError: string | null = null;
try {
  DatabaseCtor = require("better-sqlite3");
  const probe = new DatabaseCtor!(":memory:");
  probe.close();
} catch (e: unknown) {
  const err = e as Error;
  if (err.message?.includes("NODE_MODULE_VERSION") || err.message?.includes("self-register")) {
    nativeModuleError = err.message.split("\n")[0];
  } else {
    throw e;
  }
}

type Row = {
  id: string;
  threadId: string;
  labels: string[];
  accountId?: string;
  needsReply?: boolean;
  snoozed?: boolean;
};

function seed(db: DB, rows: Row[]): void {
  // snoozed_emails carries a foreign key to accounts.
  const account = db.prepare(
    `INSERT OR IGNORE INTO accounts (id, email, added_at) VALUES (?, ?, 0)`,
  );
  for (const id of new Set(rows.map((r) => r.accountId ?? "default"))) {
    account.run(id, `${id}@example.com`);
  }
  const insert = db.prepare(
    `INSERT INTO emails (id, account_id, thread_id, subject, from_address, to_address, body, date, fetched_at, label_ids)
     VALUES (?, ?, ?, 'subject', 'sender@example.com', 'me@example.com', 'body', '2026-09-22', 0, ?)`,
  );
  const analyze = db.prepare(
    `INSERT INTO analyses (email_id, needs_reply, reason, analyzed_at) VALUES (?, ?, 'because', 0)`,
  );
  const snooze = db.prepare(
    `INSERT INTO snoozed_emails (id, email_id, thread_id, account_id, snooze_until, snoozed_at)
     VALUES (?, ?, ?, ?, 0, 0)`,
  );
  for (const row of rows) {
    insert.run(row.id, row.accountId ?? "default", row.threadId, JSON.stringify(row.labels));
    if (row.needsReply !== undefined) analyze.run(row.id, row.needsReply ? 1 : 0);
    if (row.snoozed) {
      snooze.run(`s-${row.id}`, row.id, row.threadId, row.accountId ?? "default");
    }
  }
}

function count(db: DB, scope: "priority" | "all", accountId?: string): number {
  const sql = unreadThreadCountSql(scope, accountId !== undefined);
  const row = db.prepare(sql).get(...(accountId !== undefined ? [accountId] : [])) as {
    count: number;
  };
  return row.count;
}

function withDb(rows: Row[], assert: (db: DB) => void): void {
  const db = new DatabaseCtor!(":memory:");
  try {
    db.exec(SCHEMA);
    seed(db, rows);
    assert(db);
  } finally {
    db.close();
  }
}

const UNREAD = ["INBOX", "UNREAD"];
const READ = ["INBOX"];

test.describe("unreadThreadCountSql", () => {
  test.skip(() => nativeModuleError !== null, `better-sqlite3 unavailable: ${nativeModuleError}`);

  test("counts an unread inbox thread once, however many unread messages it holds", () => {
    withDb(
      [
        { id: "a1", threadId: "t1", labels: UNREAD, needsReply: true },
        { id: "a2", threadId: "t1", labels: UNREAD, needsReply: true },
        { id: "b1", threadId: "t2", labels: UNREAD, needsReply: true },
      ],
      (db) => {
        expect(count(db, "all")).toBe(2);
        expect(count(db, "priority")).toBe(2);
      },
    );
  });

  test("ignores threads whose mail has all been read", () => {
    withDb([{ id: "a1", threadId: "t1", labels: READ, needsReply: true }], (db) => {
      expect(count(db, "all")).toBe(0);
    });
  });

  test("ignores mail that has left the inbox", () => {
    withDb([{ id: "a1", threadId: "t1", labels: ["UNREAD"], needsReply: true }], (db) => {
      expect(count(db, "all")).toBe(0);
    });
  });

  test("priority counts only what the analyzer says needs a reply", () => {
    withDb(
      [
        { id: "a1", threadId: "t1", labels: UNREAD, needsReply: true },
        { id: "b1", threadId: "t2", labels: UNREAD, needsReply: false },
        { id: "c1", threadId: "t3", labels: UNREAD }, // not yet analyzed
      ],
      (db) => {
        expect(count(db, "all")).toBe(3);
        expect(count(db, "priority")).toBe(1);
      },
    );
  });

  test("a thread counts as priority when any unread message in it needs a reply", () => {
    withDb(
      [
        { id: "a1", threadId: "t1", labels: UNREAD, needsReply: false },
        { id: "a2", threadId: "t1", labels: UNREAD, needsReply: true },
      ],
      (db) => {
        expect(count(db, "priority")).toBe(1);
      },
    );
  });

  test("excludes snoozed threads — they are deliberately out of the inbox", () => {
    withDb(
      [
        { id: "a1", threadId: "t1", labels: UNREAD, needsReply: true, snoozed: true },
        { id: "b1", threadId: "t2", labels: UNREAD, needsReply: true },
      ],
      (db) => {
        expect(count(db, "all")).toBe(1);
        expect(count(db, "priority")).toBe(1);
      },
    );
  });

  test("a snooze on one message excludes the whole thread", () => {
    withDb(
      [
        { id: "a1", threadId: "t1", labels: UNREAD, needsReply: true, snoozed: true },
        { id: "a2", threadId: "t1", labels: UNREAD, needsReply: true },
      ],
      (db) => {
        expect(count(db, "all")).toBe(0);
      },
    );
  });

  test("scopes to one account when asked, and spans all of them otherwise", () => {
    withDb(
      [
        { id: "a1", threadId: "t1", labels: UNREAD, accountId: "work", needsReply: true },
        { id: "b1", threadId: "t2", labels: UNREAD, accountId: "personal", needsReply: true },
      ],
      (db) => {
        expect(count(db, "all")).toBe(2);
        expect(count(db, "all", "work")).toBe(1);
        expect(count(db, "priority", "personal")).toBe(1);
        expect(count(db, "all", "nobody")).toBe(0);
      },
    );
  });

  test("an empty inbox is zero, not null", () => {
    withDb([], (db) => {
      expect(count(db, "all")).toBe(0);
      expect(count(db, "priority")).toBe(0);
    });
  });

  test("a label that merely contains UNREAD as a substring doesn't count", () => {
    // The query matches on the quoted JSON token, so "NOT_UNREADY" can't pass.
    withDb([{ id: "a1", threadId: "t1", labels: ["INBOX", "NOT_UNREADY"] }], (db) => {
      expect(count(db, "all")).toBe(0);
    });
  });
});
