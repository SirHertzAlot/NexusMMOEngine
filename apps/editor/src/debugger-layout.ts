/**
 * Where the play-mode debugger's panels start (ROADMAP E5), and where
 * "reset layout" puts them back: status and performance down the left of
 * the game view, tools top right with the selection card (E6) under them,
 * controls (closed) bottom right. The
 * shapes are the developer client's (ui/dev-layout.ts); kept apart from
 * the panels so it tests without a browser.
 */

export interface PanelStart {
  x: number;
  y: number;
  w: number;
  h: number | null;
  opacity: number;
  open: boolean;
  collapsed: boolean;
}

export interface DebuggerLayout {
  hidden: boolean;
  panels: Record<"status" | "perf" | "tools" | "selection" | "controls", PanelStart>;
}

/** Panel ids, in the order the dev menu lists them. */
export const DEBUGGER_PANELS = ["status", "perf", "tools", "selection", "controls"] as const;

const MARGIN = 12;

export function debuggerLayoutDefaults(vp: { width: number; height: number }): DebuggerLayout {
  const panel = (x: number, y: number, w: number, open = true): PanelStart => ({ x, y, w, h: null, opacity: 0.9, open, collapsed: false });
  const right = (w: number): number => Math.max(MARGIN, vp.width - MARGIN - w);
  return {
    hidden: false,
    panels: {
      status: panel(MARGIN, MARGIN, 340),
      perf: panel(MARGIN, 124, 320),
      tools: panel(right(300), MARGIN, 300),
      // The selection card (E6) under the tools, sized to scroll its components.
      selection: { ...panel(right(320), 200, 320), h: Math.max(160, Math.min(420, vp.height - 200 - MARGIN)) },
      controls: panel(right(380), Math.max(MARGIN, vp.height - 120), 380, false),
    },
  };
}
