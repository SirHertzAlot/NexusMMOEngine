/**
 * Where a HUD widget sits is data (roadmap EA23): `content/ui/hud.json`,
 * edited in the editor's Flow & UI workspace and inlined by vite-game-ui.ts.
 * `HudSlot` pins its child to the widget's anchor box; `useHudTheme` puts
 * the file's colour tokens on the document root. Sizes are in rem, so the
 * player's UI scale (ui-scale.ts) scales the layout the way the editor's
 * overlap check assumes.
 */
import { useEffect } from "react";
import hud from "virtual:hud-layout";
import { anchorCss, themeVars } from "@mmo-engine/scene";

export function HudSlot({ id, children }: { id: string; children: React.ReactNode }): React.ReactElement | null {
  const w = hud.widgets[id];
  if (!w || w.visible === false) return null;
  const justifyContent = w.anchor.startsWith("bottom") ? "flex-end" : w.anchor.startsWith("top") ? "flex-start" : "center";
  return (
    <div className="hud-slot" data-hud={id} style={{ position: "absolute", zIndex: 10, display: "flex", flexDirection: "column", justifyContent, ...anchorCss(w) }}>
      {children}
    </div>
  );
}

export function useHudTheme(): void {
  useEffect(() => {
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(themeVars(hud.theme))) root.setProperty(k, v);
  }, []);
}
