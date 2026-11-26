/**
 * What the bottom dock holds (docs/EDITOR-UI-2026.md §2.6, slice EU5).
 *
 * The functionality reference has eight dock tabs; the styling
 * reference folds them into four — Console, Code, Source Control,
 * Integrations — and that grouping is better, which is why the rebuild
 * takes it. It could not be built until `EU8` and `EU9` landed, because
 * two of the four had nothing behind them and this shell does not draw
 * a tab that says "soon".
 *
 * Two departures from the reference's four, both deliberate:
 *
 *   - **Problems stays.** The reference has no validator over the
 *     content on disk; we do, it finds real breakage before a save, and
 *     dropping a working tab to match a picture is not a rebuild.
 *   - **Code does not become a tab.** `EU9`'s answer to the Code tab is
 *     that the editor hands off to the person's own editor, and the
 *     handoff belongs where the locations are — on each system row —
 *     not behind a tab holding a single button and a file tree we
 *     deliberately do not serve.
 *
 * Output and Bakes fold into Console, which already carries both
 * streams (`ui/console-log.ts`), so nothing is lost by the fold.
 *
 * Kept as data, away from the shell, so the regrouping is testable and
 * so a saved layout naming a tab from the other theme still opens
 * something.
 */

import type { ThemeId } from "../theme.js";

export interface DockTab {
  id: string;
  label: string;
  icon: string;
}

/** Plain count on the label, so the tab reads the same in both themes. */
const problemsTab = (count: number): DockTab => ({
  id: "problems",
  label: count > 0 ? `Problems · ${count}` : "Problems",
  icon: "error",
});

export function dockTabs(input: { theme: ThemeId; problems: number }): DockTab[] {
  if (input.theme !== "forge") {
    return [
      { id: "output", label: "Output", icon: "terminal" },
      problemsTab(input.problems),
      { id: "bakes", label: "Bakes", icon: "history" },
    ];
  }
  return [
    { id: "console", label: "Console", icon: "terminal" },
    problemsTab(input.problems),
    { id: "changes", label: "Source Control", icon: "commit" },
    { id: "integrations", label: "Integrations", icon: "hub" },
  ];
}

/**
 * Where a tab id from the other theme lands. Switching theme must not
 * leave the dock on a tab that is not there — and the fold is the
 * mapping: Output and Bakes are both inside Console now, and Console
 * read in Material 3 is the Output tab it grew out of.
 */
const ACROSS: Readonly<Record<string, string>> = {
  output: "console",
  bakes: "console",
  console: "output",
  // Source Control and Integrations have no Material 3 dock tab; they are
  // the Changes workspace and the Debug workspace's panel respectively.
  changes: "output",
  integrations: "output",
};

/** The tab to show: the current one when it exists here, else its counterpart, else the first. */
export function resolveTab(tabs: readonly DockTab[], active: string): string {
  if (tabs.some((t) => t.id === active)) return active;
  const across = ACROSS[active];
  if (across !== undefined && tabs.some((t) => t.id === across)) return across;
  return tabs[0]?.id ?? active;
}
