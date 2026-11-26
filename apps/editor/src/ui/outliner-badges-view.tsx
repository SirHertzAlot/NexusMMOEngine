/**
 * The outliner row's component badges (docs/EDITOR-UI-2026.md §2.2,
 * slice EU4), in a module of their own so the capture harness can mount
 * them without pulling the whole Scenes panel — and its hosts and
 * clients — in behind them.
 *
 * The arithmetic is in outliner-badges.ts beside this; this file is
 * only the markup. It stays in the Material 3 classes the Outliner uses,
 * because the forge theme restyles it through the token remap rather
 * than through a second component.
 */

import * as React from "react";
import type { SceneNode } from "@mmo-engine/scene";
import { COMPONENTS } from "@mmo-engine/scene";
import { badgeTitle, chipLabel, nodeBadges } from "./outliner-badges.js";

export function OutlinerBadges({ node }: { node: SceneNode }): React.JSX.Element | null {
  const { count, shown, hidden } = nodeBadges(node);
  if (count === 0) return null;
  return (
    <span className="ml-auto flex flex-none items-center gap-1" title={badgeTitle(node)}>
      {shown.map((c) => (
        <span
          key={c}
          className="rounded-sm border px-1 text-[10px] leading-4"
          style={{ borderColor: "var(--m3-outline-variant)", color: "var(--m3-on-surface-variant)" }}
        >
          {chipLabel(COMPONENTS[c]?.label ?? c)}
        </span>
      ))}
      {hidden > 0 && (
        <span className="text-[10px] leading-4" style={{ color: "var(--m3-on-surface-variant)" }}>
          +{hidden}
        </span>
      )}
      <span className="font-mono text-[10px] leading-4" style={{ color: "var(--m3-on-surface-variant)" }}>
        {count}C
      </span>
    </span>
  );
}
