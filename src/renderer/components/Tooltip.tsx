import { useState, useRef, useCallback, type ReactElement } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  /** What the action does, phrased as a short verb phrase ("Archive thread"). */
  label: string;
  /** Optional shortcut hint rendered dimmed after the label ("E"). */
  shortcut?: string;
  placement?: "top" | "bottom";
  children: ReactElement;
}

const SHOW_DELAY_MS = 400;

/**
 * Hover/focus tooltip for icon buttons.
 *
 * Rendered through a portal so it can't be clipped by a toolbar's `overflow`
 * or lose to a sibling's stacking context — both of which silently truncate
 * tooltips positioned inside the button's own subtree.
 *
 * Triggers carry `aria-label`, not `title`. A native `title` would draw a
 * second bubble alongside this one, and an earlier attempt to hide it by
 * removing the attribute during hover mutated the DOM behind React's back —
 * reconciliation never put it back, and any query running while the pointer
 * rested on a button found nothing. `aria-label` is the right accessible name
 * for an icon-only button anyway, and it is stable for tests.
 */
export function Tooltip({ label, shortcut, placement = "bottom", children }: TooltipProps) {
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerEl = (): HTMLElement | null =>
    (wrapRef.current?.firstElementChild as HTMLElement | null) ?? wrapRef.current;

  const show = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const el = triggerEl();
      if (!el) return;
      const r = el.getBoundingClientRect();
      setCoords({
        x: r.left + r.width / 2,
        y: placement === "bottom" ? r.bottom + 8 : r.top - 8,
      });
    }, SHOW_DELAY_MS);
  }, [placement]);

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setCoords(null);
  }, []);

  return (
    <>
      <span
        ref={wrapRef}
        className="contents"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        // A click means the user already knows what the control does, and the
        // tooltip would otherwise hang over the result of the action.
        onMouseDown={hide}
      >
        {children}
      </span>
      {coords &&
        createPortal(
          <div
            role="tooltip"
            style={{
              left: coords.x,
              top: coords.y,
              transform: `translate(-50%, ${placement === "bottom" ? "0" : "-100%"})`,
            }}
            className="pointer-events-none fixed z-[9999] whitespace-nowrap rounded-md bg-gray-900 dark:bg-gray-700 px-2 py-1 text-xs font-medium text-white shadow-lg ring-1 ring-black/10"
          >
            {label}
            {shortcut && <span className="ml-1.5 text-gray-400">{shortcut}</span>}
          </div>,
          document.body,
        )}
    </>
  );
}
