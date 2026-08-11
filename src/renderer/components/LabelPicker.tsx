import { useEffect, useMemo, useRef, useState } from "react";
import type { GmailLabel } from "../../shared/types";

interface LabelPickerProps {
  labels: GmailLabel[];
  /** Label ids already on the target, shown checked in "apply" mode. */
  appliedLabelIds?: string[];
  /** "apply" toggles labels in place; "move" adds one label and archives. */
  mode: "apply" | "move";
  onSelect: (labelId: string, currentlyApplied: boolean) => void;
  onClose: () => void;
}

/**
 * Dropdown for choosing a Gmail label.
 *
 * Only user-created labels are offered — Gmail refuses addLabelIds for most
 * system labels, so listing them would surface avoidable API errors.
 */
export function LabelPicker({
  labels,
  appliedLabelIds = [],
  mode,
  onSelect,
  onClose,
}: LabelPickerProps) {
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const userLabels = useMemo(
    () =>
      labels
        .filter((l) => l.type === "user")
        .filter((l) => l.name.toLowerCase().includes(query.trim().toLowerCase())),
    [labels, query],
  );

  const applied = useMemo(() => new Set(appliedLabelIds), [appliedLabelIds]);

  return (
    <div
      ref={ref}
      data-testid="label-picker"
      className="absolute z-50 mt-1 w-64 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg"
    >
      <div className="p-2 border-b border-gray-200 dark:border-gray-700">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === "move" ? "Move to label…" : "Filter labels…"}
          className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        />
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {userLabels.length === 0 && (
          <p className="px-3 py-4 text-xs text-gray-500 dark:text-gray-400 text-center">
            {labels.length === 0
              ? "No labels synced yet. They load shortly after sign-in."
              : "No matching labels"}
          </p>
        )}
        {userLabels.map((l) => {
          const isApplied = applied.has(l.id);
          return (
            <button
              key={l.id}
              onClick={() => onSelect(l.id, isApplied)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {mode === "apply" && (
                <input
                  type="checkbox"
                  readOnly
                  checked={isApplied}
                  className="pointer-events-none rounded border-gray-300 dark:border-gray-600"
                />
              )}
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: l.color || "#9ca3af" }}
              />
              <span className="truncate">{l.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
