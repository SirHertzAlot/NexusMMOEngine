/**
 * What goes off with a module (roadmap EB9).
 *
 * The Modules panel let you flip a switch and find out at the next restart.
 * Everything needed to say it beforehand was already in the panel's own
 * state: `dependsOn` says who needs whom, `systems` says what leaves the
 * tick order, `editor` says which panels disappear and `sidecar` which
 * process stops.
 *
 * It also fixes a quiet bug. The panel closed the set one level deep — it
 * dropped the modules that named the disabled one directly, but not the
 * ones that named *those* — so the host refused the save with "requires
 * X, which is not enabled" and the switch sprang back with an error. The
 * closure here is transitive, which is the same rule `resolveModuleSet`
 * checks the saved set against.
 */

export interface BlastModule {
  name: string;
  enabled: boolean;
  locked?: boolean;
  dependsOn: string[];
  systems: string[];
  editor?: boolean;
  sidecar?: boolean;
}

export interface BlastRadius {
  /** The module being turned off. */
  module: string;
  /** Enabled modules that must go off with it, nearest dependant first. */
  dependents: string[];
  /** Server systems that leave the tick order, the module's own included. */
  systems: string[];
  /** Modules whose editor panels disappear, the module's own included. */
  editorPanels: string[];
  /** Sidecar processes that stop. */
  sidecars: string[];
  /** A locked module (core) cannot be turned off at all. */
  locked: boolean;
}

/** Every enabled module that reaches `name` through dependsOn, transitively. */
export function dependentsOf(modules: readonly BlastModule[], name: string): string[] {
  const enabled = modules.filter((m) => m.enabled);
  const out: string[] = [];
  let frontier = [name];
  // Breadth-first, so the nearest dependants are listed first and the list
  // reads the way the failure would cascade.
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const m of enabled) {
      if (m.name === name || out.includes(m.name)) continue;
      if (m.dependsOn.some((d) => frontier.includes(d))) {
        out.push(m.name);
        next.push(m.name);
      }
    }
    frontier = next;
  }
  return out;
}

/** Everything that stops working if `name` is turned off. */
export function blastRadius(modules: readonly BlastModule[], name: string): BlastRadius {
  const self = modules.find((m) => m.name === name);
  const dependents = dependentsOf(modules, name);
  const going = [name, ...dependents];
  const affected = modules.filter((m) => going.includes(m.name));
  return {
    module: name,
    dependents,
    systems: affected.flatMap((m) => m.systems),
    editorPanels: affected.filter((m) => m.editor).map((m) => m.name),
    sidecars: affected.filter((m) => m.sidecar).map((m) => m.name),
    locked: self?.locked === true,
  };
}

/**
 * The enabled set after turning `name` off: without it, and without
 * anything that depended on it, however far down the chain.
 */
export function enabledAfterDisabling(
  modules: readonly BlastModule[],
  enabled: readonly string[],
  name: string,
): string[] {
  const going = new Set([name, ...dependentsOf(modules, name)]);
  return enabled.filter((n) => !going.has(n));
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The one line a module's card carries: what goes with it. */
export function blastSummary(radius: BlastRadius): string | null {
  const parts: string[] = [];
  if (radius.dependents.length > 0) parts.push(count(radius.dependents.length, "module"));
  if (radius.systems.length > 0) parts.push(count(radius.systems.length, "system"));
  if (radius.sidecars.length > 0) parts.push(count(radius.sidecars.length, "sidecar"));
  if (parts.length === 0) return null;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Turning this off takes ${list} with it`;
}

/** Whether flipping the switch deserves a question rather than an action. */
export function needsConfirming(radius: BlastRadius): boolean {
  return radius.dependents.length > 0;
}
