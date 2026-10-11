/**
 * Toolbar customization (editor architecture §3.2): which command groups show
 * and whether labels collapse to icons. Kept per browser; the pure parts are
 * here so they test without a DOM.
 */

export interface ToolbarGroup {
  id: string;
  label: string;
}

/** Groups the user can switch off. Play, Stop and the mode switch always stay. */
export const TOOLBAR_GROUPS: readonly ToolbarGroup[] = [
  { id: "document", label: "Save, Undo, Redo" },
  { id: "transform", label: "Select, Move, Rotate, Scale, Snap" },
  { id: "tick", label: "Pause and Step" },
  { id: "setup", label: "Play setup summary" },
  { id: "modules", label: "Modules chip" },
  { id: "layout", label: "Layout menu" },
];

export interface ToolbarConfig {
  hidden: string[];
  iconsOnly: boolean;
}

export const DEFAULT_TOOLBAR: ToolbarConfig = { hidden: [], iconsOnly: false };

const KEY = "nexus.editor.toolbar";

export function parseToolbar(raw: string | null): ToolbarConfig {
  if (!raw) return DEFAULT_TOOLBAR;
  try {
    const v = JSON.parse(raw) as Partial<ToolbarConfig>;
    const known = new Set(TOOLBAR_GROUPS.map((g) => g.id));
    const hidden = Array.isArray(v.hidden) ? v.hidden.filter((id): id is string => typeof id === "string" && known.has(id)) : [];
    return { hidden, iconsOnly: v.iconsOnly === true };
  } catch {
    return DEFAULT_TOOLBAR;
  }
}

export function toggleGroup(cfg: ToolbarConfig, id: string): ToolbarConfig {
  const hidden = cfg.hidden.includes(id) ? cfg.hidden.filter((h) => h !== id) : [...cfg.hidden, id];
  return { ...cfg, hidden };
}

export const isShown = (cfg: ToolbarConfig, id: string): boolean => !cfg.hidden.includes(id);

export function loadToolbar(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): ToolbarConfig {
  try {
    return parseToolbar(storage?.getItem(KEY) ?? null);
  } catch {
    return DEFAULT_TOOLBAR;
  }
}

export function saveToolbar(cfg: ToolbarConfig, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(cfg));
  } catch {
    // storage blocked: the setting lasts for this session only
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
