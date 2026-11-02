/**
 * HudSlot: positions a widget from the HUD layout.
 *
 * Each widget renders inside <HudSlot id="player-frame">, which reads the
 * widget's anchor + offset from the layout context and absolutely positions
 * it. Moving a widget is a hud.json edit, never a code change.
 */
import * as React from "react";
import { anchorStyle, DEFAULT_LAYOUT, withDefaults, type HudLayout } from "./hud-layout.js";
import { useHudJson } from "../hooks/swr";

const HudLayoutContext = React.createContext<HudLayout>(DEFAULT_LAYOUT);

export function HudLayoutProvider({
  layout,
  children,
}: {
  layout?: HudLayout | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const merged = React.useMemo(() => withDefaults(layout), [layout]);
  return (
    <HudLayoutContext.Provider value={merged}>
      {children}
    </HudLayoutContext.Provider>
  );
}

/** Fetch hud.json with SWR deduplication (60s deduping interval). */
export { useHudJson } from "../hooks/swr";

// Avoid unused import warning
void useHudJson;

function HudSlotImpl({
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

export const HudSlot = React.memo(HudSlotImpl);
HudSlot.displayName = "HudSlot";
