import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

export interface ContextMenuActions {
  replaceMisspelling: (suggestion: string) => void;
  addToDictionary: (word: string) => void;
}

/**
 * The right-click menu. Electron shows none by default, so without this a
 * right-click does nothing: no spelling corrections, no cut/copy/paste.
 * Suggestions come from Chromium's spellchecker (the macOS one on a Mac) and
 * are listed first, the way native apps do. Returns [] when there is nothing
 * to offer, e.g. a right-click on plain unselected text.
 */
export function contextMenuTemplate(
  params: Pick<
    ContextMenuParams,
    "misspelledWord" | "dictionarySuggestions" | "isEditable" | "editFlags" | "selectionText"
  >,
  actions: ContextMenuActions,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];

  if (params.misspelledWord) {
    if (params.dictionarySuggestions.length === 0) {
      items.push({ label: "No Guesses Found", enabled: false });
    }
    for (const suggestion of params.dictionarySuggestions) {
      items.push({ label: suggestion, click: () => actions.replaceMisspelling(suggestion) });
    }
    items.push(
      { type: "separator" },
      {
        label: "Learn Spelling",
        click: () => actions.addToDictionary(params.misspelledWord),
      },
      { type: "separator" },
    );
  }

  if (params.isEditable) {
    items.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll" },
    );
  } else if (params.selectionText.trim()) {
    items.push({ role: "copy" });
  }

  return items;
}
