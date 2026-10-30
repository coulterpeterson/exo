/**
 * The right-click menu (src/main/utils/context-menu-template.ts). Electron
 * shows no context menu at all by default, so before this a right-click on a
 * misspelled word offered no way to correct it.
 */
import { test, expect } from "@playwright/test";
import { contextMenuTemplate } from "../../src/main/utils/context-menu-template";

const editFlags = {
  canUndo: true,
  canRedo: true,
  canCut: false,
  canCopy: false,
  canPaste: true,
  canDelete: false,
  canSelectAll: true,
  canEditRichly: true,
};

function setup() {
  const calls: string[] = [];
  const actions = {
    replaceMisspelling: (s: string) => calls.push(`replace:${s}`),
    addToDictionary: (w: string) => calls.push(`learn:${w}`),
  };
  return { calls, actions };
}

test.describe("contextMenuTemplate", () => {
  test("a misspelled word offers its corrections first, and picking one replaces it", () => {
    const { calls, actions } = setup();
    const items = contextMenuTemplate(
      {
        misspelledWord: "asyncronously",
        dictionarySuggestions: ["asynchronously"],
        isEditable: true,
        editFlags,
        selectionText: "",
      },
      actions,
    );

    expect(items[0].label).toBe("asynchronously");
    items[0].click?.({} as never, undefined, {} as never);
    const learn = items.find((i) => i.label === "Learn Spelling");
    learn?.click?.({} as never, undefined, {} as never);
    expect(calls).toEqual(["replace:asynchronously", "learn:asyncronously"]);

    // Editing commands follow, with availability from Chromium's edit flags.
    expect(items.filter((i) => i.role).map((i) => [i.role, i.enabled])).toEqual([
      ["cut", false],
      ["copy", false],
      ["paste", true],
      ["selectAll", undefined],
    ]);
  });

  test("a misspelling with no guesses says so instead of showing nothing", () => {
    const items = contextMenuTemplate(
      {
        misspelledWord: "qwzxv",
        dictionarySuggestions: [],
        isEditable: true,
        editFlags,
        selectionText: "",
      },
      setup().actions,
    );
    expect(items[0]).toEqual({ label: "No Guesses Found", enabled: false });
  });

  test("selected text in a message offers Copy; unselected text offers nothing", () => {
    const base = {
      misspelledWord: "",
      dictionarySuggestions: [],
      isEditable: false,
      editFlags,
    };
    expect(contextMenuTemplate({ ...base, selectionText: "some text" }, setup().actions)).toEqual([
      { role: "copy" },
    ]);
    expect(contextMenuTemplate({ ...base, selectionText: "" }, setup().actions)).toEqual([]);
  });
});
