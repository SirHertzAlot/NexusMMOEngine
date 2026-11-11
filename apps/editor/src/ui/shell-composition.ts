/**
 * Shell composition (T2): the pure walk that turns a resolved shell
 * template's regions tree into the mount list the App shell renders from.
 *
 * The shell's composition — which bars, docks and surfaces mount, and in
 * what arrangement — is template data, decided by the shell slot's pin
 * and resolved through PresentationResolver (see authoring/templates.ts).
 * This module only reads a definition: depth-first, a region's own panes
 * in order, then its child regions in order. App.tsx gates each surface
 * it renders on the composition, so moving the pin (or a template that
 * omits a surface) changes what mounts — and the resolver's fallback
 * chain guarantees a composition always exists.
 */

import type { InterfaceRegion, ViewTemplateDefinition } from "../authoring/templates.js";

/** The component type of a shell dock pane; which dock is its config's `side`. */
export const SHELL_DOCK_COMPONENT = "shell-dock";

export interface ShellPanePlacement {
  /** Pane instance id from the template. */
  id: string;
  /** Component type from INTERFACE_COMPONENTS. */
  component: string;
  /** The region the pane sits in. */
  regionId: string;
  config?: Readonly<Record<string, unknown>>;
}

export interface ShellComposition {
  /** Region ids in walk order. */
  readonly regionIds: readonly string[];
  /** Every pane placement in walk order. */
  readonly panes: readonly ShellPanePlacement[];
  /** True when any pane instantiates this component type. */
  has(component: string): boolean;
  /** The sides of the shell-dock panes, in walk order ("left", "bottom", "right" for the current shell). */
  dockSides(): readonly string[];
  /** True when a shell-dock pane carries this side. */
  hasDock(side: string): boolean;
}

export function composeShell(definition: ViewTemplateDefinition): ShellComposition {
  const regionIds: string[] = [];
  const panes: ShellPanePlacement[] = [];
  const visit = (region: InterfaceRegion): void => {
    regionIds.push(region.id);
    for (const pane of region.panes ?? []) {
      panes.push({
        id: pane.id,
        component: pane.component,
        regionId: region.id,
        ...(pane.config ? { config: pane.config } : {}),
      });
    }
    for (const child of region.children ?? []) visit(child);
  };
  for (const region of definition.regions) visit(region);
  const components = new Set(panes.map((p) => p.component));
  const sides = panes
    .filter((p) => p.component === SHELL_DOCK_COMPONENT)
    .map((p) => p.config?.side)
    .filter((s): s is string => typeof s === "string");
  return {
    regionIds,
    panes,
    has: (component) => components.has(component),
    dockSides: () => [...sides],
    hasDock: (side) => sides.includes(side),
  };
}
