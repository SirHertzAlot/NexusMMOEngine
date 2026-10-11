/**
 * lil-gui dev tweak panel (TL3).
 *
 * DEV-only live tweak panel for the vanilla-three.js editor. Three seeded
 * control groups:
 * - Viewport: grid toggle, axes helper, background color
 * - Selection: outline color, transform gizmo size
 * - Performance: show FPS, draw call count
 *
 * DEV-gated: the panel only initializes when `import.meta.env.DEV` is true.
 * lil-gui is a devDependency, so it's never in the prod bundle.
 */
import GUI from "lil-gui";

export interface EditorTweakState {
  viewport: {
    showGrid: boolean;
    showAxes: boolean;
    background: string;
  };
  selection: {
    outlineColor: string;
    gizmoSize: number;
  };
  performance: {
    showFps: boolean;
    showDrawCalls: boolean;
  };
}

export const defaultTweakState: EditorTweakState = {
  viewport: {
    showGrid: true,
    showAxes: false,
    background: "#1a1a2e",
  },
  selection: {
    outlineColor: "#ffaa00",
    gizmoSize: 1,
  },
  performance: {
    showFps: false,
    showDrawCalls: false,
  },
};

/**
 * Create the dev tweak panel. Returns null in production.
 * The caller should destroy the GUI when the editor unmounts.
 */
export function createDevTweakPanel(
  state: EditorTweakState = defaultTweakState,
  onChange?: (state: EditorTweakState) => void
): GUI | null {
  if (typeof process !== "undefined" && process.env.NODE_ENV === "production") return null;

  const gui = new GUI({ title: "Dev Tweaks" });

  const viewport = gui.addFolder("Viewport");
  viewport.add(state.viewport, "showGrid").onChange(() => onChange?.(state));
  viewport.add(state.viewport, "showAxes").onChange(() => onChange?.(state));
  viewport.addColor(state.viewport, "background").onChange(() => onChange?.(state));

  const selection = gui.addFolder("Selection");
  selection.addColor(state.selection, "outlineColor").onChange(() => onChange?.(state));
  selection.add(state.selection, "gizmoSize", 0.5, 2, 0.1).onChange(() => onChange?.(state));

  const perf = gui.addFolder("Performance");
  perf.add(state.performance, "showFps").onChange(() => onChange?.(state));
  perf.add(state.performance, "showDrawCalls").onChange(() => onChange?.(state));

  return gui;
}
