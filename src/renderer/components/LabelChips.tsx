import { useMemo } from "react";
import { visibleLabelIds, type GmailLabel } from "../../shared/types";

interface LabelChipsProps {
  labelIds?: string[];
  labels: GmailLabel[];
  /** Cap chips so a heavily-labelled thread can't crowd out the subject.
   *  Overflow collapses into a "+N" chip. */
  max?: number;
  onRemove?: (labelId: string) => void;
}

/**
 * Gmail-style label chips.
 *
 * Only user-created labels are shown — see visibleLabelIds. Gmail's own labels
 * (INBOX/UNREAD/CATEGORY_*) are already conveyed by the view the user is in, so
 * chipping them would put a badge on nearly every row.
 */
export function LabelChips({ labelIds, labels, max = 3, onRemove }: LabelChipsProps) {
  const shown = useMemo(() => visibleLabelIds(labelIds, labels), [labelIds, labels]);
  const byId = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);

  if (shown.length === 0) return null;

  const visible = shown.slice(0, max);
  const overflow = shown.length - visible.length;

  return (
    <span className="inline-flex items-center gap-1 align-middle" data-testid="label-chips">
      {visible.map((id) => {
        const label = byId.get(id);
        if (!label) return null;
        return (
          <span
            key={id}
            title={label.name}
            className="inline-flex items-center gap-1 max-w-[10rem] rounded px-1.5 py-0.5 text-[11px] font-medium leading-none bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200"
            style={
              label.color
                ? { backgroundColor: label.color, color: pickReadableText(label.color) }
                : undefined
            }
          >
            <span className="truncate">{label.name}</span>
            {onRemove && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(id);
                }}
                className="shrink-0 opacity-60 hover:opacity-100"
                aria-label={`Remove label ${label.name}`}
              >
                ×
              </button>
            )}
          </span>
        );
      })}
      {overflow > 0 && (
        <span className="rounded px-1.5 py-0.5 text-[11px] font-medium leading-none bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
          +{overflow}
        </span>
      )}
    </span>
  );
}

/** Gmail label colors are user-chosen and can be very light or very dark, so
 *  pick the text color from luminance rather than assuming a dark chip. */
function pickReadableText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "inherit";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  // Rec. 601 luma — good enough for a two-way light/dark text decision.
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? "#111827" : "#ffffff";
}
