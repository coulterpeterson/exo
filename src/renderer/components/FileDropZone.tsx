import { useCallback, useState } from "react";
import type React from "react";

/**
 * Turns a compose form into a drop target for files dragged in from outside
 * the app. Spread `onDragEnter` on the form's (position: relative) root and
 * render <FileDropOverlay> while `isDraggingFiles`.
 *
 * Only drags that carry files count, so dragging a recipient chip between
 * address fields or a text selection into the editor behaves as before.
 */
export function useFileDropZone() {
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) setIsDraggingFiles(true);
  }, []);
  const endDrag = useCallback(() => setIsDraggingFiles(false), []);
  return { isDraggingFiles, onDragEnter, endDrag };
}

/**
 * Covers the whole form while files are over it, so the drop lands here
 * rather than in the editor (which would inline an image) or on an iframe.
 * Its contents ignore the pointer, so dragleave only fires on leaving the
 * form, not on crossing the label.
 */
export function FileDropOverlay({
  onDrop,
  onLeave,
}: {
  onDrop: (files: File[]) => void;
  onLeave: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-400 bg-blue-50/90 dark:bg-blue-950/80"
      data-testid="compose-file-drop-zone"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={onLeave}
      onDrop={(e) => {
        e.preventDefault();
        onLeave();
        onDrop(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="pointer-events-none flex flex-col items-center gap-1 text-blue-700 dark:text-blue-300">
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
          />
        </svg>
        <span className="text-sm font-medium">Drop files to attach</span>
      </div>
    </div>
  );
}
