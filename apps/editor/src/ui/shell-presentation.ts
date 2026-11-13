/**
 * The shell slot's presentation state (T2): registry, pins and resolver
 * for the editor's outer shell, mirroring the authoring slot's bootstrap
 * in authoring-view.tsx. The shell slot is pinned to the current shell
 * template by default; App.tsx renders the composition that resolution
 * produces (shell-composition.ts). Pins are session state here — T3/T4
 * move templates to documents on disk and pins to per-user prefs.
 */

import {
  PresentationPins,
  PresentationResolver,
  SHELL_TEMPLATE_ID,
  createBuiltinRegistry,
  type Provenance,
  type Resolution,
} from "../authoring/index.js";
import { composeShell, type ShellComposition } from "./shell-composition.js";

const bootstrapProvenance: Provenance = {
  who: { id: "editor", role: "developer" },
  what: "shell slot presentation",
  when: 1_800_000_000_000,
  where: "Editor shell",
  why: "built-in template registration",
};

export const shellRegistry = createBuiltinRegistry(bootstrapProvenance);
export const shellPins = new PresentationPins();
export const shellResolver = new PresentationResolver();
shellPins.pin("shell", { templateId: SHELL_TEMPLATE_ID, version: 1 }, { ...bootstrapProvenance, why: "default pin: the current shell" }, shellRegistry);

/** Resolve the shell slot through its pin; falls back, never throws, while a legacy shell is registered. */
export function resolveShell(): Resolution {
  return shellResolver.resolve("shell", shellPins, shellRegistry);
}

/** The composition App.tsx renders from: the resolved shell template, walked. */
export function currentShellComposition(): ShellComposition {
  return composeShell(resolveShell().template.definition);
}
