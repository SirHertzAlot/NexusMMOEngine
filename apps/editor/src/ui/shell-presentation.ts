/**
 * The shell slot's presentation state (T2): registry, pins and resolver for the editor's outer shell, mirroring the
 * authoring slot's bootstrap in authoring-view.tsx. The shell slot is pinned to the current shell template by default;
 * App.tsx renders the composition that resolution produces (shell-composition.ts), and follows the pins: moving one
 * re-composes the running editor (`subscribe`, `useShellComposition`). Pins are session state here: T3/T4 move
 * templates to documents on disk and pins to per-user prefs.
 *
 * A presentation is made by `createShellPresentation`, so a test (or a second editor window) gets its own registry
 * and pins; `defaultShell` is the one the editor uses.
 */

import {
  PresentationPins,
  PresentationResolver,
  SHELL_TEMPLATE_ID,
  createBuiltinRegistry,
  type Provenance,
  type Resolution,
  type TemplateRegistry,
} from "../authoring/index.js";
import { composeShell, type ShellComposition } from "./shell-composition.js";

export interface ShellPresentation {
  readonly registry: TemplateRegistry;
  readonly pins: PresentationPins;
  readonly resolver: PresentationResolver;
  /** Resolve the shell slot through its pin; falls back, never throws, while a legacy shell is registered. */
  resolve(): Resolution;
  /**
   * The composition of what the slot resolves to now. The same object while the resolved template has not changed, so
   * a UI can compare snapshots by identity.
   */
  composition(): ShellComposition;
  /** Be told when the shell slot's pin moves. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** `now` is the clock the bootstrap provenance is stamped with (default: the real one). */
export function createShellPresentation(now: () => number = Date.now): ShellPresentation {
  const bootstrap: Provenance = {
    who: { id: "editor", role: "developer" },
    what: "shell slot presentation",
    when: now(),
    where: "Editor shell",
    why: "built-in template registration",
  };
  const registry = createBuiltinRegistry(bootstrap);
  const pins = new PresentationPins();
  const resolver = new PresentationResolver();
  pins.pin("shell", { templateId: SHELL_TEMPLATE_ID, version: 1 }, { ...bootstrap, why: "default pin: the current shell" }, registry);
  const resolve = (): Resolution => resolver.resolve("shell", pins, registry);
  let last: { template: Resolution["template"]; composition: ShellComposition } | null = null;
  return {
    registry,
    pins,
    resolver,
    resolve,
    composition() {
      const { template } = resolve();
      if (!last || last.template !== template) last = { template, composition: composeShell(template.definition) };
      return last.composition;
    },
    subscribe(listener) {
      return pins.subscribe((slot) => {
        if (slot === "shell") listener();
      });
    },
  };
}

/** The editor's shell presentation. */
export const defaultShell = createShellPresentation();

export const shellRegistry = defaultShell.registry;
export const shellPins = defaultShell.pins;
export const shellResolver = defaultShell.resolver;

/** Resolve the shell slot through its pin (the editor's). */
export function resolveShell(): Resolution {
  return defaultShell.resolve();
}

/** The composition App.tsx renders from: the resolved shell template, walked. */
export function currentShellComposition(): ShellComposition {
  return defaultShell.composition();
}
