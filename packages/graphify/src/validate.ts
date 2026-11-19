import {
  EcsGraphSchema,
  FILE_LINE_RE,
  archetypeId,
  canonicalJson,
  type EcsGraph,
} from "./schema.js";
import type { IntrospectionResult } from "./introspect.js";
import type { DeclaredAccessEntry, RosterSystemInfo } from "./ast-extract.js";
import { INFERRED_SIM_ALLOWLIST, MAX_UNANNOTATED_SIM_SYSTEMS } from "./roles.js";

export interface ValidateContext {
  introspected?: IntrospectionResult;
  roster?: readonly RosterSystemInfo[];
  declaredDeclarations?: readonly {
    rosterName: string;
    expectedSimName?: string;
    declaration: DeclaredAccessEntry;
  }[];
  enforceAllowlistRatchet?: boolean;
}

/**
 * Enforce all §7 validation invariants and the H3 allowlist ratchet.
 * Throws a detailed multi-problem Error if any invariant is violated.
 */
export function validateGraph(graph: EcsGraph, ctx: ValidateContext = {}): EcsGraph {
  const problems: string[] = [];

  // 1. Schema round-trip
  const parsed = EcsGraphSchema.safeParse(graph);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(`schema[${issue.path.join(".")}]: ${issue.message}`);
    }
    throw new Error(`Graph validation failed (${problems.length} schema error(s)):\n  ${problems.join("\n  ")}`);
  }

  const nodeIds = new Set<string>();
  const componentNodes = new Map<string, Extract<EcsGraph["nodes"][number], { kind: "component" }>>();
  const fieldNodes = new Map<string, Extract<EcsGraph["nodes"][number], { kind: "field" }>>();
  const systemNodes = new Map<string, Extract<EcsGraph["nodes"][number], { kind: "system" }>>();
  const archetypeNodes: Array<Extract<EcsGraph["nodes"][number], { kind: "archetype" }>> = [];

  for (const node of parsed.data.nodes) {
    if (nodeIds.has(node.id)) {
      problems.push(`duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);
    if (node.kind === "component") componentNodes.set(node.name, node);
    else if (node.kind === "field") fieldNodes.set(`${node.component}.${node.name}`, node);
    else if (node.kind === "system") systemNodes.set(node.name, node);
    else if (node.kind === "archetype") archetypeNodes.push(node);
  }

  // 2. Every edge from/to exists in nodes
  const fieldOfPairs = new Set<string>();
  const declaredEdgeKeys = new Set<string>();
  if (ctx.declaredDeclarations) {
    for (const entry of ctx.declaredDeclarations) {
      const sysId = `system:${entry.rosterName}`;
      for (const r of entry.declaration.reads) {
        if (typeof r === "string") declaredEdgeKeys.add(`${sysId}\u0000reads\u0000component:${r}`);
        else for (const f of r.fields) declaredEdgeKeys.add(`${sysId}\u0000reads\u0000field:${r.component}.${f}`);
      }
      for (const w of entry.declaration.writes) {
        if (typeof w === "string") declaredEdgeKeys.add(`${sysId}\u0000writes\u0000component:${w}`);
        else for (const f of w.fields) declaredEdgeKeys.add(`${sysId}\u0000writes\u0000field:${w.component}.${f}`);
      }
      for (const ex of entry.declaration.excludes) {
        declaredEdgeKeys.add(`${sysId}\u0000excludes\u0000component:${ex}`);
      }
    }
  }

  for (const edge of parsed.data.edges) {
    if (!nodeIds.has(edge.from)) {
      problems.push(`dangling edge.from "${edge.from}" (${edge.kind} -> ${edge.to})`);
    }
    if (!nodeIds.has(edge.to)) {
      problems.push(`dangling edge.to "${edge.to}" (${edge.from} ${edge.kind} ->)`);
    }
    if (edge.kind === "fieldOf") {
      fieldOfPairs.add(`${edge.from}->${edge.to}`);
    }
    // 7. No edge carries confidence "declared" without a backing declaration
    if (edge.confidence === "declared" && ctx.declaredDeclarations) {
      const key = `${edge.from}\u0000${edge.kind}\u0000${edge.to}`;
      if (!declaredEdgeKeys.has(key)) {
        problems.push(`edge "${edge.from} ${edge.kind} ${edge.to}" claims confidence="declared" without a backing declaration`);
      }
    }
  }

  // Verify every field node has a `fieldOf` edge to its parent component
  for (const fn of fieldNodes.values()) {
    const expectedFrom = `field:${fn.component}.${fn.name}`;
    const expectedTo = `component:${fn.component}`;
    if (!fieldOfPairs.has(`${expectedFrom}->${expectedTo}`)) {
      problems.push(`field node "${expectedFrom}" missing fieldOf edge to "${expectedTo}"`);
    }
  }

  // 3 & 4. Introspected components and fields match 1:1 with graph nodes
  if (ctx.introspected) {
    if (componentNodes.size !== ctx.introspected.components.length) {
      problems.push(
        `component count mismatch: graph has ${componentNodes.size}, introspection yielded ${ctx.introspected.components.length}`,
      );
    }
    const expectedFields = new Set<string>();
    for (const ic of ctx.introspected.components) {
      const gn = componentNodes.get(ic.name);
      if (!gn) {
        problems.push(`introspected component "${ic.name}" missing from graph.nodes`);
        continue;
      }
      if (gn.fields.length !== ic.fields.length) {
        problems.push(
          `component "${ic.name}" field count mismatch: graph=${gn.fields.length}, introspected=${ic.fields.length}`,
        );
      }
      for (const inf of ic.fields) {
        const key = `${ic.name}.${inf.name}`;
        expectedFields.add(key);
        const fn = fieldNodes.get(key);
        if (!fn) {
          problems.push(`introspected field "${key}" missing from graph.nodes`);
        } else if (fn.fieldType !== inf.type || fn.sab !== inf.sab) {
          problems.push(`field "${key}" metadata mismatch against introspected schema`);
        }
      }
    }
    for (const key of fieldNodes.keys()) {
      if (!expectedFields.has(key)) {
        problems.push(`field node "${key}" does not match any introspected component field`);
      }
    }
  }

  // 5. Every component/field named in a `declared` SystemAccess exists in Stage 1
  if (ctx.declaredDeclarations && ctx.introspected) {
    const byComp = new Map(ctx.introspected.components.map((c) => [c.name, c]));
    for (const item of ctx.declaredDeclarations) {
      const { rosterName, expectedSimName, declaration } = item;
      if (expectedSimName && declaration.system !== expectedSimName) {
        problems.push(
          `SystemAccess on "${rosterName}" has system="${declaration.system}", expected SimSystem.name "${expectedSimName}"`,
        );
      }
      const checkRefs = (
        refs: ReadonlyArray<string | { component: string; fields: string[] }>,
        dir: string,
      ): void => {
        for (const r of refs) {
          const compName = typeof r === "string" ? r : r.component;
          const ic = byComp.get(compName);
          if (!ic) {
            problems.push(`declared ${dir} on "${rosterName}" names non-existent component "${compName}" (${declaration.source})`);
            continue;
          }
          if (typeof r !== "string") {
            const validFields = new Set(ic.fields.map((f) => f.name));
            for (const fname of r.fields) {
              if (!validFields.has(fname)) {
                problems.push(
                  `declared ${dir} on "${rosterName}" names non-existent field "${compName}.${fname}" (${declaration.source})`,
                );
              }
            }
          }
        }
      };
      checkRefs(declaration.reads, "reads");
      checkRefs(declaration.writes, "writes");
      for (const ex of declaration.excludes) {
        if (!byComp.has(ex)) {
          problems.push(`declared excludes on "${rosterName}" names non-existent component "${ex}" (${declaration.source})`);
        }
      }
    }
  }

  // 6. Every system in the resolved tick roster appears in nodes with non-empty role
  if (ctx.roster) {
    for (const rs of ctx.roster) {
      const sn = systemNodes.get(rs.rosterName);
      if (!sn) {
        problems.push(`tick roster system "${rs.rosterName}" (module "${rs.moduleName}") missing from graph.nodes`);
      } else if (!sn.role) {
        problems.push(`tick roster system "${rs.rosterName}" has empty role`);
      }
    }
  }

  // 8. Every unresolved entry has non-empty site formatted as file:line
  for (let i = 0; i < parsed.data.meta.unresolved.length; i++) {
    const u = parsed.data.meta.unresolved[i];
    if (!u.site || !FILE_LINE_RE.test(u.site)) {
      problems.push(`meta.unresolved[${i}].site "${u.site}" is missing or not formatted as file:line`);
    }
  }

  // 9. Archetype hashing purity check
  for (const arch of archetypeNodes) {
    const expected = archetypeId(arch.components);
    const reversed = archetypeId([...arch.components].reverse());
    if (arch.id !== expected || expected !== reversed) {
      problems.push(`archetype "${arch.id}" failed hash purity check (expected "${expected}")`);
    }
  }

  // H3 allowlist ratchet check
  if (ctx.enforceAllowlistRatchet && ctx.roster) {
    const allowSet = new Set(INFERRED_SIM_ALLOWLIST);
    const unannotatedSim = ctx.roster.filter((s) => s.role === "simulation" && !s.declared);
    for (const s of unannotatedSim) {
      if (!allowSet.has(s.rosterName)) {
        problems.push(
          `H3 ratchet violation: unannotated simulation system "${s.rosterName}" is not in INFERRED_SIM_ALLOWLIST (declare SimSystem.access)`,
        );
      }
    }
    if (unannotatedSim.length > MAX_UNANNOTATED_SIM_SYSTEMS) {
      problems.push(
        `H3 ratchet violation: ${unannotatedSim.length} unannotated simulation systems exceed MAX_UNANNOTATED_SIM_SYSTEMS (${MAX_UNANNOTATED_SIM_SYSTEMS})`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Graph validation failed (${problems.length} problem(s)):\n  ${problems.join("\n  ")}`);
  }

  return parsed.data;
}

/** 10. Determinism check helper: asserts two serialized canonical artifacts are byte-identical. */
export function assertDeterministicBytes(a: EcsGraph | string, b: EcsGraph | string): void {
  const sa = typeof a === "string" ? a : canonicalJson(a);
  const sb = typeof b === "string" ? b : canonicalJson(b);
  if (sa !== sb) {
    throw new Error("Determinism check failed: two builds on the same tree produced differing bytes.");
  }
}
