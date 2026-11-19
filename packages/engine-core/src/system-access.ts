/**
 * Declarative ECS component and field access metadata for SimSystem instances.
 *
 * Systems carry `access?: SystemAccess` (and optional per-module `system-access.json`
 * overrides) so static extraction tools can record component/field dataflow with
 * `"declared"` confidence and verify all referenced names against live bitECS schemas.
 */

/**
 * Reference to either a whole component (tag, existence check, or whole-store
 * read/write) or a named list of fields on a single component.
 */
export type AccessRef =
  | string
  | { readonly component: string; readonly fields: readonly string[] };

/** Component and field read/write/exclusion contract for a simulation system. */
export interface SystemAccess {
  /** System name matching `SimSystem.name` (or module roster system name in JSON). */
  readonly system: string;
  readonly reads: readonly AccessRef[];
  readonly writes: readonly AccessRef[];
  readonly excludes?: readonly string[];
}
