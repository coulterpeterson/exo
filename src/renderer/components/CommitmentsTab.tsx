import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isUnconfirmedCommitment,
  type Commitment,
  type CommitmentKind,
  type IpcResponse,
} from "../../shared/types";

declare global {
  interface Window {
    api: {
      commitments: {
        list: (accountId: string) => Promise<IpcResponse<Commitment[]>>;
        save: (input: Record<string, unknown>) => Promise<IpcResponse<Commitment>>;
        update: (id: string, updates: Record<string, unknown>) => Promise<IpcResponse<Commitment>>;
        confirm: (id: string) => Promise<IpcResponse<Commitment>>;
        setStatus: (id: string, status: string) => Promise<IpcResponse<Commitment>>;
        delete: (id: string) => Promise<IpcResponse<void>>;
        today: () => Promise<IpcResponse<string>>;
      };
    };
  }
}

const KIND_LABELS: Record<CommitmentKind, string> = {
  date_range: "Date window",
  deal_accepted: "Deal accepted",
  deal_declined: "Deal declined",
  terms: "Terms",
  other: "Other",
};

interface CommitmentsTabProps {
  accountId: string;
}

interface DraftForm {
  kind: CommitmentKind;
  counterpartyLabel: string;
  counterpartyEmail: string;
  statement: string;
  startDate: string;
  endDate: string;
}

const EMPTY_FORM: DraftForm = {
  kind: "date_range",
  counterpartyLabel: "",
  counterpartyEmail: "",
  statement: "",
  startDate: "",
  endDate: "",
};

/** Do two active exclusive windows collide? Mirrors the inclusive-end rule in
 *  main/utils/date-range.ts — ISO strings compare chronologically. */
function overlaps(a: Commitment, b: Commitment): boolean {
  const aStart = a.startDate ?? "0000-01-01";
  const aEnd = a.endDate ?? "9999-12-31";
  const bStart = b.startDate ?? "0000-01-01";
  const bEnd = b.endDate ?? "9999-12-31";
  return aStart <= bEnd && bStart <= aEnd;
}

export function CommitmentsTab({ accountId }: CommitmentsTabProps) {
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [today, setToday] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [form, setForm] = useState<DraftForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<DraftForm>(EMPTY_FORM);
  const [showRetired, setShowRetired] = useState(false);

  const load = useCallback(async () => {
    const [listed, day] = await Promise.all([
      window.api.commitments.list(accountId),
      window.api.commitments.today(),
    ]);
    if (listed.success) setCommitments(listed.data);
    if (day.success) setToday(day.data);
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const { upcoming, past, retired } = useMemo(() => {
    const upcoming: Commitment[] = [];
    const past: Commitment[] = [];
    const retired: Commitment[] = [];
    for (const c of commitments) {
      if (c.status !== "active") retired.push(c);
      else if (c.endDate && today && c.endDate < today) past.push(c);
      else upcoming.push(c);
    }
    return { upcoming, past, retired };
  }, [commitments, today]);

  /** Active exclusive windows that collide with another — a real-world data
   *  problem (double-booked yourself) the user needs to see, not something to
   *  silently resolve. */
  const conflictingIds = useMemo(() => {
    const dated = upcoming.filter((c) => c.exclusive && (c.startDate || c.endDate));
    const ids = new Set<string>();
    for (let i = 0; i < dated.length; i++) {
      for (let j = i + 1; j < dated.length; j++) {
        if (overlaps(dated[i], dated[j])) {
          ids.add(dated[i].id);
          ids.add(dated[j].id);
        }
      }
    }
    return ids;
  }, [upcoming]);

  const handleAdd = async () => {
    setError(null);
    const result = await window.api.commitments.save({
      accountId,
      kind: form.kind,
      statement: form.statement,
      counterpartyLabel: form.counterpartyLabel || undefined,
      counterpartyEmail: form.counterpartyEmail || undefined,
      startDate: form.startDate || undefined,
      endDate: form.endDate || undefined,
      datePrecision: form.startDate ? "exact" : "none",
    });
    if (!result.success) {
      setError(result.error ?? "Could not save");
      return;
    }
    setForm(EMPTY_FORM);
    setIsAdding(false);
    await load();
  };

  const startEdit = (c: Commitment) => {
    setEditingId(c.id);
    setEditForm({
      kind: c.kind,
      counterpartyLabel: c.counterpartyLabel ?? "",
      counterpartyEmail: c.counterpartyEmail ?? "",
      statement: c.statement,
      startDate: c.startDate ?? "",
      endDate: c.endDate ?? "",
    });
  };

  const handleSaveEdit = async (id: string) => {
    setError(null);
    const result = await window.api.commitments.update(id, {
      kind: editForm.kind,
      statement: editForm.statement,
      counterpartyLabel: editForm.counterpartyLabel || undefined,
      counterpartyEmail: editForm.counterpartyEmail || undefined,
      startDate: editForm.startDate || null,
      endDate: editForm.endDate || null,
    });
    if (!result.success) {
      setError(result.error ?? "Could not save");
      return;
    }
    setEditingId(null);
    await load();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this commitment? Drafts will stop taking it into account.")) return;
    await window.api.commitments.delete(id);
    await load();
  };

  const fields = (value: DraftForm, onChange: (v: DraftForm) => void) => (
    <div className="space-y-2">
      <div className="flex gap-2">
        <select
          value={value.kind}
          onChange={(e) => onChange({ ...value, kind: e.target.value as CommitmentKind })}
          className="px-2 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        >
          {Object.entries(KIND_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <input
          value={value.counterpartyLabel}
          onChange={(e) => onChange({ ...value, counterpartyLabel: e.target.value })}
          placeholder="Who (e.g. Emma at Acme)"
          className="flex-1 px-2 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        />
        <input
          value={value.counterpartyEmail}
          onChange={(e) => onChange({ ...value, counterpartyEmail: e.target.value })}
          placeholder="their@email.com"
          className="flex-1 px-2 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        />
      </div>
      <input
        value={value.statement}
        onChange={(e) => onChange({ ...value, statement: e.target.value })}
        placeholder="What was agreed — e.g. sponsored main-channel video"
        className="w-full px-2 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
      />
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-500 dark:text-gray-400">From</label>
        <input
          type="date"
          value={value.startDate}
          onChange={(e) => onChange({ ...value, startDate: e.target.value })}
          className="px-2 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        />
        <label className="text-xs text-gray-500 dark:text-gray-400">to</label>
        <input
          type="date"
          value={value.endDate}
          onChange={(e) => onChange({ ...value, endDate: e.target.value })}
          className="px-2 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        />
        <span className="text-xs text-gray-400 dark:text-gray-500">
          Leave dates empty for a fact with no window
        </span>
      </div>
    </div>
  );

  const row = (c: Commitment) => {
    const unconfirmed = isUnconfirmedCommitment(c);
    const conflicted = conflictingIds.has(c.id);
    if (editingId === c.id) {
      return (
        <div
          key={c.id}
          className="p-3 rounded-lg border border-blue-300 dark:border-blue-700 bg-blue-50/50 dark:bg-blue-900/20"
        >
          {fields(editForm, setEditForm)}
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => handleSaveEdit(c.id)}
              className="px-3 py-1 text-xs font-medium rounded bg-blue-600 dark:bg-blue-500 text-white"
            >
              Save
            </button>
            <button
              onClick={() => setEditingId(null)}
              className="px-3 py-1 text-xs text-gray-600 dark:text-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }

    return (
      <div
        key={c.id}
        data-testid="commitment-row"
        className="p-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
      >
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {(c.startDate || c.endDate) && (
                <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200">
                  {c.startDate ?? "…"} → {c.endDate ?? "…"}
                </span>
              )}
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {KIND_LABELS[c.kind]}
              </span>
              {unconfirmed && (
                <span
                  data-testid="commitment-unconfirmed"
                  title="Extracted automatically and not yet verified — drafts are told to treat it with caution"
                  className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300"
                >
                  Unconfirmed
                </span>
              )}
              {conflicted && (
                <span
                  data-testid="commitment-conflict"
                  title="Overlaps another active commitment"
                  className="text-[11px] px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300"
                >
                  Overlaps another
                </span>
              )}
            </div>
            <p className="text-sm text-gray-900 dark:text-gray-100 mt-1">{c.statement}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {c.counterpartyLabel ?? c.counterpartyEmail ?? "No counterparty"}
              {c.status !== "active" && ` · ${c.status}`}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {unconfirmed && (
              <button
                onClick={async () => {
                  await window.api.commitments.confirm(c.id);
                  await load();
                }}
                className="px-2 py-1 text-xs rounded text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/30"
              >
                Confirm
              </button>
            )}
            <button
              onClick={() => startEdit(c)}
              className="px-2 py-1 text-xs rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              Edit
            </button>
            <button
              onClick={() => handleDelete(c.id)}
              className="px-2 py-1 text-xs rounded text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">Commitments</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Deals and date windows you&apos;ve promised. Drafts to <em>anyone</em> take these into
          account, so a window booked for one sponsor won&apos;t be offered to another.
        </p>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800">
          <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
        </div>
      )}

      {isAdding ? (
        <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          {fields(form, setForm)}
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleAdd}
              disabled={!form.statement.trim()}
              data-testid="commitment-add-save"
              className="px-3 py-1 text-xs font-medium rounded bg-blue-600 dark:bg-blue-500 text-white disabled:opacity-50"
            >
              Add commitment
            </button>
            <button
              onClick={() => {
                setIsAdding(false);
                setForm(EMPTY_FORM);
                setError(null);
              }}
              className="px-3 py-1 text-xs text-gray-600 dark:text-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setIsAdding(true)}
          data-testid="commitment-add"
          className="px-3 py-1.5 text-sm font-medium rounded-lg bg-blue-600 dark:bg-blue-500 text-white"
        >
          Add commitment
        </button>
      )}

      <section>
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Active &amp; upcoming ({upcoming.length})
        </h4>
        {upcoming.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-gray-500">
            Nothing yet. Add the windows you&apos;ve already promised so drafts stop offering them.
          </p>
        ) : (
          <div className="space-y-2">{upcoming.map(row)}</div>
        )}
      </section>

      {past.length > 0 && (
        <section>
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Past ({past.length})
          </h4>
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">
            Window has closed — no longer applied to drafts.
          </p>
          <div className="space-y-2 opacity-70">{past.map(row)}</div>
        </section>
      )}

      {retired.length > 0 && (
        <section>
          <button
            onClick={() => setShowRetired((v) => !v)}
            className="text-sm font-medium text-gray-600 dark:text-gray-300 hover:underline"
          >
            {showRetired ? "Hide" : "Show"} superseded &amp; cancelled ({retired.length})
          </button>
          {showRetired && <div className="space-y-2 mt-2 opacity-70">{retired.map(row)}</div>}
        </section>
      )}
    </div>
  );
}
