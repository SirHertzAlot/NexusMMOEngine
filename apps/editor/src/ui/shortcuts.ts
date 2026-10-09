/**
 * Editor keyboard shortcuts — pure resolver + focus guard.
 *
 * The shell advertises F5 / Shift+F5 / V / W / E / R (shortcuts dialog,
 * Play button title, command palette). Every one must either run or lose
 * its hint — never a hint that lies. The DOM wiring lives in ui/App.tsx;
 * this module stays framework-free so node --test can cover it.
 */

export type EditorShortcutAction =
  | "play"
  | "stop"
  | "tool-select"
  | "tool-move"
  | "tool-rotate"
  | "tool-scale";

export interface ShortcutKey {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** Toolbar button labels the tool shortcuts activate (same handlers). */
export const TOOL_SHORTCUT_BUTTON_LABELS: Record<
  Extract<EditorShortcutAction, "tool-select" | "tool-move" | "tool-rotate" | "tool-scale">,
  string
> = {
  "tool-select": "Select (V)",
  "tool-move": "Move (W)",
  "tool-rotate": "Rotate (E)",
  "tool-scale": "Scale (R)",
};

/**
 * True when the key event target is a text-entry element: typing there
 * must not trigger single-key shortcuts (V/W/E/R) or steal F5.
 */
export function shouldSkipShortcut(target: EventTarget | null | undefined): boolean {
  if (target === null || target === undefined) return false;
  const el = target as Partial<HTMLElement> & { tagName?: string };
  const tag = (el.tagName ?? "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable === true) return true;
  const getAttr = (el as Partial<Element> & { getAttribute?: (n: string) => string | null }).getAttribute;
  if (typeof getAttr === "function") {
    try {
      if (getAttr.call(el as Element, "contenteditable") === "true") return true;
    } catch {
      /* non-element target: fall through */
    }
  }
  return false;
}

/**
 * Map a key event to its editor action, or null when the shell does not
 * handle it. Ctrl/Cmd combinations are never tool shortcuts (Ctrl+V is
 * paste, not Select); Ctrl+F5 / Alt+F5 keep their browser meaning.
 */
export function resolveEditorShortcut(e: ShortcutKey): EditorShortcutAction | null {
  const mod = e.ctrlKey === true || e.metaKey === true;
  if (e.key === "F5") {
    if (mod || e.altKey === true) return null;
    return e.shiftKey === true ? "stop" : "play";
  }
  if (mod || e.altKey === true || e.shiftKey === true) return null;
  switch (e.key.toLowerCase()) {
    case "v":
      return "tool-select";
    case "w":
      return "tool-move";
    case "e":
      return "tool-rotate";
    case "r":
      return "tool-scale";
    default:
      return null;
  }
}
