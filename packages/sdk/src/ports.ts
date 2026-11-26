/**
 * Ports: how a host reaches a system it did not build.
 *
 * A region's tick is a flat array of systems, and the host — our gateway, or
 * a game's own — has to reach into it: the thing that drains this tick's
 * blows, the thing a key press triggers. The obvious way is `instanceof`,
 * and that is what our gateway did: `systems.find((x) => x instanceof
 * CombatSystem)`. It costs the host a value import of every class it looks
 * for, which is the one import a system cannot have if it is to move out of
 * the engine and into a kit a game forks.
 *
 * A port replaces the class with a name. A system says which ports it
 * offers, the host declares the ports it reads and what each one must
 * answer to, and the lookup is by name. Nothing the host imports at runtime
 * belongs to the system, so the system can live in another package, be
 * replaced wholesale by a game's own, or not exist at all.
 *
 * The shape of each port stays the host's business: the table below carries
 * the method names, so a system that offers a port it cannot answer is
 * caught at boot, next to the other problems, rather than in the first tick
 * that reaches for the missing method.
 */

/**
 * The key a system declares its ports under.
 *
 * `Symbol.for` on purpose: two copies of this package in one process (a game
 * pinning its own) still agree on the symbol, where a module-local symbol
 * would make every system look portless to the other copy's host.
 */
export const PORTS: unique symbol = Symbol.for("mmo-engine.ports");

/** A system that offers ports. Declared as `readonly [PORTS] = ["combat"];`. */
export interface PortProvider {
  readonly [PORTS]: readonly string[];
}

/** One port a host reads, and what a system must answer to offer it. */
export interface PortDecl {
  /** The name a system offers it under. */
  readonly key: string;
  /** Methods the host calls on it. A provider missing one fails the boot. */
  readonly methods: readonly string[];
  /**
   * Data members the host reads rather than calls — a count, a tunable.
   * Checked for presence only, since a getter cannot be read at boot
   * without running it, and a field holding `0` is still a field.
   */
  readonly fields?: readonly string[];
  /** What the host uses it for, for the error message. */
  readonly what: string;
}

/** A system that offered a port it cannot answer. */
export interface BadPort {
  /** The port it offered. */
  readonly key: string;
  /** The system's constructor name, or `anonymous`. */
  readonly system: string;
  /** Why it does not answer: an unknown key, or the members it lacks. */
  readonly problem: "unknown port" | "missing members";
  /** The methods and fields it lacks, for `missing members`. */
  readonly missing: readonly string[];
}

/** Thrown at boot when a system offers a port it cannot answer. */
export class BadPortError extends Error {
  constructor(readonly bad: readonly BadPort[]) {
    super(
      `${bad.length} system${bad.length === 1 ? "" : "s"} offer a port they cannot answer:\n` +
        bad
          .map((b) =>
            b.problem === "unknown port"
              ? `  - ${b.system} offers "${b.key}", which this host does not read`
              : `  - ${b.system} offers "${b.key}" without ${b.missing.join(", ")}`,
          )
          .join("\n"),
    );
    this.name = "BadPortError";
  }
}

const systemName = (value: object): string => {
  const name = value.constructor?.name;
  return typeof name === "string" && name.length > 0 ? name : "anonymous";
};

const offers = (value: unknown): value is PortProvider & object =>
  value !== null &&
  typeof value === "object" &&
  Array.isArray((value as Record<PropertyKey, unknown>)[PORTS]);

/**
 * What a host found behind its ports. Built once from a fixed systems array;
 * a host whose systems change rebuilds it.
 */
export class PortSet<P extends object> {
  constructor(
    private readonly table: readonly PortDecl[],
    private readonly found: ReadonlyMap<string, readonly unknown[]>,
  ) {}

  /** Every system behind `key`, in the order the systems array has them. */
  all<K extends keyof P & string>(key: K): readonly P[K][] {
    return (this.found.get(key) ?? []) as readonly P[K][];
  }

  /** The first system behind `key`, or `undefined` when nothing offers it. */
  first<K extends keyof P & string>(key: K): P[K] | undefined {
    return this.found.get(key)?.[0] as P[K] | undefined;
  }

  /** Whether anything offers `key`. */
  has(key: keyof P & string): boolean {
    return (this.found.get(key)?.length ?? 0) > 0;
  }

  /** The ports nothing offers, sorted — the host's own optional features. */
  get absent(): readonly string[] {
    return this.table
      .map((d) => d.key)
      .filter((key) => !this.found.has(key))
      .sort();
  }

  /** `ports: 4/6, off: duels, telegraphs` — one boot line. */
  get summary(): string {
    const absent = this.absent;
    const head = `ports: ${this.table.length - absent.length}/${this.table.length}`;
    return absent.length === 0 ? head : `${head}, off: ${absent.join(", ")}`;
  }
}

/**
 * Open the ports `table` declares over `systems`.
 *
 * Fail-closed, and every problem at once: a system that offers a port this
 * host does not read, or offers one without the methods the host calls, ends
 * the boot. A port nothing offers is not a problem — it is a feature this
 * run does not have, which the host asks about with `has` or handles by the
 * `undefined` from `first`.
 */
export function openPorts<P extends object>(
  table: readonly PortDecl[],
  systems: Iterable<unknown>,
): PortSet<P> {
  const byKey = new Map<string, PortDecl>();
  for (const decl of table) {
    if (byKey.has(decl.key)) throw new Error(`port table declares "${decl.key}" twice`);
    byKey.set(decl.key, decl);
  }

  const found = new Map<string, unknown[]>();
  const bad: BadPort[] = [];
  for (const system of systems) {
    if (!offers(system)) continue;
    for (const key of system[PORTS]) {
      const decl = byKey.get(key);
      if (!decl) {
        bad.push({ key, system: systemName(system), problem: "unknown port", missing: [] });
        continue;
      }
      const members = system as unknown as Record<string, unknown>;
      const missing = [
        ...decl.methods.filter((method) => typeof members[method] !== "function"),
        ...(decl.fields ?? []).filter((field) => !(field in members)),
      ];
      if (missing.length > 0) {
        bad.push({ key, system: systemName(system), problem: "missing members", missing });
        continue;
      }
      const list = found.get(key);
      if (list) list.push(system);
      else found.set(key, [system]);
    }
  }
  if (bad.length > 0) throw new BadPortError(bad);
  return new PortSet<P>(table, found);
}
