/** The toolbar's "Viewport options" menu: Grid, Gizmos, Wireframe and Screenshot for whichever 3D viewport is open. */

import * as React from "react";
import { OverflowMenu } from "./components.js";
import { viewportOptionRows } from "./menu-model.js";
import { screenshotViewport } from "./shell-actions.js";
import { getViewport, getViewportFlags, subscribeViewport, toggleViewportFlag } from "./viewport-bus.js";

export function ViewportOptions(): React.JSX.Element {
  const vp = React.useSyncExternalStore(subscribeViewport, getViewport);
  const flags = React.useSyncExternalStore(subscribeViewport, getViewportFlags);
  const rows = viewportOptionRows(vp, flags, { toggle: toggleViewportFlag, screenshot: () => void screenshotViewport() });
  return <OverflowMenu label="Viewport options" size={36} items={rows} />;
}
