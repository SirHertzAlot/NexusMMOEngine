/**
 * The service registry: how a host reads back what the enabled modules built.
 *
 * Module assembly hands the host a bag of instances keyed by name. Reading
 * that bag directly costs a cast per read and turns a disabled module into
 * an `undefined` that surfaces as a `TypeError` several frames later, long
 * after the fact that explains it.
 *
 * A registry is that bag plus a declaration table: one row per service the
 * host reads, naming the module that provides it, whether the host can run
 * without it, and what it is for. The host then asks for a service by key
 * and gets it typed, or gets one error at boot naming the module to enable.
 *
 * The table is deliberately a list of what *this host* reads, not a list of
 * what a module may provide. A game that drops a system the engine's own
 * entry point happens to read can see exactly which rows to change, and a
 * game with its own entry point writes its own table and uses none of ours.
 */

/** One service a host reads back after assembly. */
export interface ServiceDecl {
  /** The name the providing module declares it under. */
  readonly key: string;
  /** The module that provides it, for the error message. */
  readonly module: string;
  /**
   * `system` for a tick system (assembly's `byName`), `extension` for a
   * gateway extension (assembly's `extensions`), which never ticks.
   */
  readonly kind: "system" | "extension";
  /** `false` when the host runs without it; the registry then answers `undefined`. */
  readonly required: boolean;
  /** What the host uses it for, for the error message and the docs. */
  readonly what: string;
}

/** Everything a registry is built from: the declarations and the two bags. */
export interface ServiceSources {
  readonly systems: Readonly<Record<string, unknown>>;
  readonly extensions: Readonly<Record<string, unknown>>;
  /** Modules that were enabled this boot, for the error message. */
  readonly modules?: readonly string[];
}

/** A missing service, with enough to say what to do about it. */
export interface MissingService {
  readonly key: string;
  readonly module: string;
  readonly kind: "system" | "extension";
  readonly what: string;
  /** `true` when the module ran but did not provide it (so enabling it is not the fix). */
  readonly moduleEnabled: boolean;
}

export class MissingServicesError extends Error {
  constructor(readonly missing: readonly MissingService[]) {
    super(
      `${missing.length} service${missing.length === 1 ? "" : "s"} the server needs ${missing.length === 1 ? "is" : "are"} not available:\n` +
        missing
          .map(
            (m) =>
              `  - ${m.key} (${m.what}), provided by the ${m.module} module — ${
                m.moduleEnabled
                  ? `that module is enabled but did not provide it`
                  : `enable ${m.module} in the module set (content/modules.json, or MMO_MODULES)`
              }`,
          )
          .join("\n"),
    );
    this.name = "MissingServicesError";
  }
}

/**
 * Reads services by key, typed against `S`.
 *
 * `get` is for a required service and never answers `undefined`: a missing
 * one has already stopped the boot in {@link openServiceRegistry}. `optional`
 * is for a service the host has a path without, and answers `undefined`
 * when its module is off.
 */
export class ServiceRegistry<S extends object> {
  constructor(
    private readonly decls: ReadonlyMap<string, ServiceDecl>,
    private readonly values: ReadonlyMap<string, unknown>,
  ) {}

  /** A service the table marks required. */
  get<K extends keyof S & string>(key: K): S[K] {
    const decl = this.decls.get(key);
    if (decl === undefined) throw new Error(`service ${key} is not in the table`);
    if (!decl.required) {
      throw new Error(`service ${key} is optional — read it with optional("${key}"), which can answer undefined`);
    }
    return this.values.get(key) as S[K];
  }

  /** A service the host can run without. */
  optional<K extends keyof S & string>(key: K): S[K] | undefined {
    if (!this.decls.has(key)) throw new Error(`service ${key} is not in the table`);
    return this.values.get(key) as S[K] | undefined;
  }

  /** `true` when the service is present this boot. */
  has(key: keyof S & string): boolean {
    return this.values.has(key);
  }

  /** The optional services that are not here this boot, in table order. */
  get absent(): readonly string[] {
    return [...this.decls.values()].filter((d) => !this.values.has(d.key)).map((d) => d.key);
  }

  /** One line for the boot log. */
  get summary(): string {
    const absent = this.absent;
    return `services: ${this.values.size}/${this.decls.size}${absent.length ? `, off: ${absent.join(", ")}` : ""}`;
  }
}

/**
 * Build a registry, stopping the boot if a required service is missing.
 *
 * Every problem is reported at once, the way the module assembler and the
 * rules loader do, so one run tells a reader everything to fix.
 */
export function openServiceRegistry<S extends object>(
  table: readonly ServiceDecl[],
  sources: ServiceSources,
): ServiceRegistry<S> {
  const decls = new Map<string, ServiceDecl>();
  const values = new Map<string, unknown>();
  const missing: MissingService[] = [];
  const enabled = new Set(sources.modules ?? []);

  for (const decl of table) {
    if (decls.has(decl.key)) throw new Error(`service ${decl.key} is declared twice`);
    decls.set(decl.key, decl);
    const bag = decl.kind === "system" ? sources.systems : sources.extensions;
    const value = bag[decl.key];
    if (value === undefined || value === null) {
      if (decl.required) {
        missing.push({
          key: decl.key,
          module: decl.module,
          kind: decl.kind,
          what: decl.what,
          moduleEnabled: enabled.has(decl.module),
        });
      }
      continue;
    }
    values.set(decl.key, value);
  }

  if (missing.length > 0) throw new MissingServicesError(missing);
  return new ServiceRegistry<S>(decls, values);
}
