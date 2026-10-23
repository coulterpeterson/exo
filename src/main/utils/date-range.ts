/** Local-date helpers. */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Today as YYYY-MM-DD in local time. Clock injectable for tests. */
export function todayISO(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}
