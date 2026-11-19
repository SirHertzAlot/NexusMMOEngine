/**
 * The shell composition as React state that follows the shell slot's pin: a pin move (or rollback) re-renders the
 * editor with the new composition, no reload. The snapshot is stable by identity until the resolved template changes.
 */
import * as React from "react";
import { defaultShell, type ShellPresentation } from "./shell-presentation.js";
import type { ShellComposition } from "./shell-composition.js";

export function useShellComposition(presentation: ShellPresentation = defaultShell): ShellComposition {
  return React.useSyncExternalStore(presentation.subscribe, presentation.composition, presentation.composition);
}
