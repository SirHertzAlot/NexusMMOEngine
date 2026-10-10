/**
 * HudSlot: positions a widget from the HUD layout.
 *
 * Each widget renders inside <HudSlot id="player-frame">, which reads the
 * widget's anchor + offset from the layout context and absolutely positions
 * it. Moving a widget is a hud.json edit, never a code change.
 */
import * as React from "react";
import { anchorStyle, DEFAULT_LAYOUT, loadHudLayout, type HudLayout } from "./hud-layout.js";

const HudLayoutContext = React.createContext<HudLayout>(DEFAULT_LAYOUT);

export function HudLayoutProvider({
  layout,
  children,
}: {
  layout?: HudLayout | null;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <HudLayoutContext.Provider value={layout ?? DEFAULT_LAYOUT}>
      {children}
    </HudLayoutContext.Provider>
  );
}

/** Fetch hud.json once; fall back to the default layout on any failure. */
export function useHudJson(url = "/content/ui/hud.json"): HudLayout | null {
  const [layout, setLayout] = React.useState<HudLayout | null>(null);
  React.useEffect(() => {
    let live = true;
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!live) return;
        try {
          setLayout(json ? loadHudLayout(json) : null);
        } catch {
          setLayout(null);
        }
      })
      .catch(() => {
        if (live) setLayout(null);
      });
    return () => {
      live = false;
    };
  }, [url]);
  return layout;
}

export function HudSlot({
  id,
  children,
  className,
}: {
  id: string;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element | null {
  const layout = React.useContext(HudLayoutContext);
  const placement = layout.widgets[id];
  if (!placement || !placement.visible) return null;
  return (
    <div className={className} style={anchorStyle(placement.anchor, placement.offset)}>
      {children}
    </div>
  );
}
