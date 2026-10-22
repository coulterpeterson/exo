import { useState, useRef, useEffect } from "react";
import { useAppStore } from "../store";
import type {
  DashboardEmail,
  IpcResponse,
  MoveToPriorityResult,
  MoveToPriorityRule,
} from "../../shared/types";

type SingleChoice = "once" | "sender" | "type";

function senderParts(from: string): { name: string; address: string } {
  const angled = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (angled) return { name: angled[1].trim() || angled[2], address: angled[2].trim() };
  return { name: from.trim(), address: from.trim() };
}

/**
 * "Move to Priority" — correct the analyzer, optionally teach it, and start a
 * reply draft.
 *
 * `emails` are the messages each thread's Priority status is read from (the
 * latest one received, not the user's own reply). One email gets the full
 * choice of how far the lesson should reach; several get a single question —
 * "what kind of emails are these?" — because "always from this sender" across
 * a mixed selection would be a pile of rules the user never looked at.
 */
export function MoveToPriorityDialog({
  emails,
  onClose,
  onMoved,
  waitingOnOthersCount = 0,
}: {
  emails: DashboardEmail[];
  onClose: () => void;
  /** After a successful move, before closing (e.g. to clear a bulk selection). */
  onMoved?: () => void;
  /** Selected threads left out because the user replied last (bulk only). */
  waitingOnOthersCount?: number;
}) {
  const isBulk = emails.length > 1;
  const [choice, setChoice] = useState<SingleChoice>("once");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const firstOptionRef = useRef<HTMLInputElement>(null);

  // Focus where the user will act first: the description in bulk mode, the
  // choices otherwise.
  useEffect(() => {
    if (isBulk) textareaRef.current?.focus();
    else firstOptionRef.current?.focus();
  }, [isBulk]);

  useEffect(() => {
    if (choice === "type") textareaRef.current?.focus();
  }, [choice]);

  const { name: senderName, address: senderAddress } = senderParts(emails[0]?.from ?? "");
  const trimmed = description.trim();

  const submit = async (rule: MoveToPriorityRule) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = (await window.api.analysis.moveToPriority({
        emailIds: emails.map((e) => e.id),
        rule,
      })) as IpcResponse<MoveToPriorityResult>;
      if (!response.success) {
        setError(response.error);
        return;
      }
      // Move them in the list now rather than waiting for a reload. The
      // backend has already saved the same verdict.
      const store = useAppStore.getState();
      const analyzedAt = Date.now();
      for (const id of response.data.moved) {
        store.updateEmail(id, {
          analysis: { needsReply: true, reason: "You moved this to Priority", analyzedAt },
        });
      }
      onMoved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move to Priority");
    } finally {
      setBusy(false);
    }
  };

  const submitSingle = () => {
    if (choice === "type") {
      if (!trimmed) return;
      void submit({ kind: "type", description: trimmed });
    } else {
      void submit({ kind: choice === "sender" ? "sender" : "none" });
    }
  };

  const canSubmitSingle = choice !== "type" || trimmed.length > 0;

  const optionClass = (active: boolean) =>
    `flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
      active
        ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
        : "border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/40"
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      // The inbox's single-key shortcuts listen on window. Without this, `e`
      // pressed with a radio focused would archive the thread behind the dialog.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-to-priority-title"
        data-testid="move-to-priority-dialog"
        className="w-full max-w-md mx-4 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700"
      >
        <div className="px-5 pt-5 pb-3">
          <h2
            id="move-to-priority-title"
            className="text-base font-semibold text-gray-900 dark:text-gray-100"
          >
            {isBulk ? `Move ${emails.length} emails to Priority` : "Move to Priority"}
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {isBulk
              ? "Exo will draft replies. What kind of emails are these? Describe them and similar ones will be Priority from now on."
              : "Exo will draft a reply. Should this change how future emails are sorted?"}
          </p>
        </div>

        <div className="px-5 pb-4 space-y-2">
          {!isBulk && (
            <>
              <label className={optionClass(choice === "once")}>
                <input
                  ref={firstOptionRef}
                  type="radio"
                  name="move-to-priority"
                  className="mt-1"
                  checked={choice === "once"}
                  onChange={() => setChoice("once")}
                />
                <span>
                  <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                    Just this email
                  </span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    A one-off. Nothing is learned.
                  </span>
                </span>
              </label>

              <label className={optionClass(choice === "sender")}>
                <input
                  type="radio"
                  name="move-to-priority"
                  className="mt-1"
                  checked={choice === "sender"}
                  onChange={() => setChoice("sender")}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                    Always for this sender
                  </span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400 truncate">
                    {senderName === senderAddress
                      ? senderAddress
                      : `${senderName} <${senderAddress}>`}
                  </span>
                </span>
              </label>

              <label className={optionClass(choice === "type")}>
                <input
                  type="radio"
                  name="move-to-priority"
                  className="mt-1"
                  checked={choice === "type"}
                  onChange={() => setChoice("type")}
                />
                <span>
                  <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                    Always for emails like this
                  </span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    From anyone. Describe the kind of email below.
                  </span>
                </span>
              </label>
            </>
          )}

          {(isBulk || choice === "type") && (
            <textarea
              ref={textareaRef}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                // Cmd/Ctrl+Enter submits; plain Enter is a newline.
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (trimmed) void submit({ kind: "type", description: trimmed });
                }
              }}
              rows={3}
              maxLength={300}
              data-testid="move-to-priority-description"
              placeholder={
                isBulk
                  ? "e.g. sponsorship offers and brand collaboration requests"
                  : "e.g. customer-support follow-ups about a product I own"
              }
              className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 outline-none focus:border-blue-500"
            />
          )}

          {waitingOnOthersCount > 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {waitingOnOthersCount === 1
                ? "1 selected thread stays in Other: you replied last, so it's waiting on them."
                : `${waitingOnOthersCount} selected threads stay in Other: you replied last, so they're waiting on them.`}
            </p>
          )}
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>

        <div className="px-5 py-3 flex justify-end gap-2 border-t border-gray-100 dark:border-gray-700/60">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            Cancel
          </button>
          {isBulk ? (
            <>
              <button
                type="button"
                onClick={() => void submit({ kind: "none" })}
                disabled={busy}
                data-testid="move-to-priority-just-these"
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                Just these emails
              </button>
              <button
                type="button"
                onClick={() => void submit({ kind: "type", description: trimmed })}
                disabled={busy || !trimmed}
                data-testid="move-to-priority-save-rule"
                className="px-3 py-1.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Save rule &amp; move
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={submitSingle}
              disabled={busy || !canSubmitSingle}
              data-testid="move-to-priority-submit"
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Move to Priority
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
