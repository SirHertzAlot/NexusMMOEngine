import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { extractAllFromAst } from "./ast-extract.js";
import {
  DEFAULT_ADD_COMPONENT_PATH,
  DEFAULT_INTROSPECT_MODULES,
  introspectComponents,
  type IntrospectModuleSpec,
} from "./introspect.js";
import {
  archetypeId,
  finalizeGraph,
  toPosixPath,
  type CoverageEntry,
  type EcsGraph,
  type GraphEdge,
  type GraphNode,
} from "./schema.js";
import { validateGraph } from "./validate.js";

export interface HarvestOptions {
  repoRoot?: string;
  introspectModules?: readonly IntrospectModuleSpec[];
  addComponentPath?: string;
  engineVersion?: string;
  enforceAllowlistRatchet?: boolean;
  builtFromCommit?: string;
}

interface RawSceneNode {
  id: string;
  name?: string;
  kind?: string;
  components?: Record<string, unknown>;
  children?: RawSceneNode[];
}

interface RawSceneDoc {
  name?: string;
  kind?: string;
  nodes?: RawSceneNode[];
}

function resolveGitCommit(repoRoot: string): string {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || "unknown";
  } catch {
    return "unknown";
  }
}

function sha256File(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

function flattenSceneNodes(nodes: readonly RawSceneNode[] | undefined): RawSceneNode[] {
  if (!Array.isArray(nodes)) return [];
  const flat: RawSceneNode[] = [];
  const visit = (list: readonly RawSceneNode[]): void => {
    for (const n of list) {
      if (n && typeof n === "object" && typeof n.id === "string") {
        flat.push(n);
      }
      if (Array.isArray(n?.children)) {
        visit(n.children);
      }
    }
  };
  visit(nodes);
  return flat;
}

/**
 * Run the full 5-stage graphify extraction pipeline over a repository tree:
 * Introspect (child process) -> Parse (TS AST) -> Join (S7 content objects) ->
 * Validate (§7 + H3 ratchet) -> Finalize canonical deterministic graph.
 */
export function harvest(options: HarvestOptions = {}): EcsGraph {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const builtFromCommit = options.builtFromCommit ?? resolveGitCommit(repoRoot);

  // Stage 1: Subprocess bitECS introspection
  const introspected = introspectComponents({
    repoRoot,
    modules: options.introspectModules,
    addComponentPath: options.addComponentPath,
  });

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const trackedSourceFiles = new Set<string>();

  for (const modSpec of options.introspectModules ?? DEFAULT_INTROSPECT_MODULES) {
    if (existsSync(resolve(repoRoot, modSpec.relSource))) {
      trackedSourceFiles.add(toPosixPath(modSpec.relSource));
    }
  }
  if (existsSync(resolve(repoRoot, "packages/engine-core/src/admin/add-component.ts"))) {
    trackedSourceFiles.add("packages/engine-core/src/admin/add-component.ts");
  }
  const addCompAbs = options.addComponentPath
    ? resolve(repoRoot, options.addComponentPath)
    : resolve(repoRoot, DEFAULT_ADD_COMPONENT_PATH);
  if (!existsSync(addCompAbs) && options.addComponentPath) {
    // Allow synthetic fixture paths cleanly without noisy hash misses
  }

  // Stage 2: TS AST extraction (S3-S6, S8-S10)
  const ast = extractAllFromAst(repoRoot, introspected.components, {
    engineVersion: options.engineVersion,
  });
  for (const f of ast.trackedSourceFiles) trackedSourceFiles.add(f);
  nodes.push(...ast.nodes);
  edges.push(...ast.edges);

  const coverage: CoverageEntry[] = [
    {
      source: "S1/S2 component introspection",
      status: "extracted",
      count: introspected.components.length,
      details: `${introspected.components.length} live bitECS components (${introspected.addableNames.length} editor-addable)`,
    },
    ...ast.coverage,
  ];

  // Emit S1/S2 component & field nodes (enriched with S10 protocol metadata)
  for (const comp of introspected.components) {
    nodes.push({
      id: `component:${comp.name}`,
      kind: "component",
      name: comp.name,
      source: comp.source,
      ...(comp.componentId !== undefined ? { componentId: comp.componentId } : {}),
      sab: comp.sab,
      tag: comp.tag,
      addable: comp.addable,
      fields: comp.fields.map((f) => ({
        name: f.name,
        type: f.type,
        ...(f.arrayLength !== undefined ? { arrayLength: f.arrayLength } : {}),
      })),
    });

    for (const f of comp.fields) {
      const fid = `field:${comp.name}.${f.name}`;
      const rows = ast.protocolFieldRows.get(`${comp.name}.${f.name}`);
      nodes.push({
        id: fid,
        kind: "field",
        name: f.name,
        component: comp.name,
        fieldType: f.type,
        sab: f.sab,
        ...(f.arrayLength !== undefined ? { arrayLength: f.arrayLength } : {}),
        ...(rows && rows.length > 0 ? { protocolRows: rows } : {}),
        source: comp.source,
      });
      edges.push({
        from: fid,
        to: `component:${comp.name}`,
        kind: "fieldOf",
        confidence: "introspected",
        source: comp.source,
      });
    }
  }

  // Stage 3: S7 Content objects & Archetype deduplication
  const scenesDir = resolve(repoRoot, "content/scenes");
  const archetypeAccum = new Map<
    string,
    {
      components: string[];
      objectCount: number;
      sources: Map<string, string>; // ECS component -> S8 source file:line
      sceneKinds: Set<string>;
    }
  >();

  let totalSceneObjects = 0;
  let realizedSceneObjects = 0;

  if (existsSync(scenesDir)) {
    const sceneFiles = readdirSync(scenesDir)
      .filter((f) => f.endsWith(".scene.json"))
      .sort();

    for (const fileName of sceneFiles) {
      const absScene = join(scenesDir, fileName);
      const relScene = toPosixPath(relative(repoRoot, absScene));
      trackedSourceFiles.add(relScene);

      const doc = JSON.parse(readFileSync(absScene, "utf8")) as RawSceneDoc;
      const sceneName = doc.name ?? fileName.replace(/\.scene\.json$/, "");
      const flatNodes = flattenSceneNodes(doc.nodes);
      const seenObjectIds = new Set<string>();

      for (const sn of flatNodes) {
        // Guard against duplicate nested ids within a single scene file
        const uniqueObjKey = seenObjectIds.has(sn.id) ? `${sn.id}#${seenObjectIds.size}` : sn.id;
        seenObjectIds.add(sn.id);
        totalSceneObjects++;

        const sceneKinds = Object.keys(sn.components ?? {}).sort();
        const ecsCompSet = new Set<string>();
        const compSources = new Map<string, string>();

        for (const sk of sceneKinds) {
          const realization = ast.sceneComponentRealization.get(sk);
          if (!realization) continue;
          for (const ecsComp of realization.components) {
            ecsCompSet.add(ecsComp);
            if (!compSources.has(ecsComp)) {
              compSources.set(ecsComp, realization.source);
            }
          }
        }
        // Per scene-spawn.ts (`walkThrough = Collider?.shape === "none"`), walk-through
        // stand-ins omit static physics BodyConfig/Velocity.
        const colComp = sn.components?.Collider as { shape?: unknown } | undefined;
        if (colComp && colComp.shape === "none" && !sn.components?.Spawner) {
          ecsCompSet.delete("BodyConfig");
          ecsCompSet.delete("Velocity");
        }

        const ecsComps = [...ecsCompSet].sort();
        let archId: string | undefined;

        if (ecsComps.length > 0) {
          realizedSceneObjects++;
          archId = archetypeId(ecsComps);
          let entry = archetypeAccum.get(archId);
          if (!entry) {
            entry = {
              components: ecsComps,
              objectCount: 0,
              sources: new Map<string, string>(),
              sceneKinds: new Set<string>(),
            };
            archetypeAccum.set(archId, entry);
          }
          entry.objectCount++;
          for (const [k, s] of compSources) {
            if (!entry.sources.has(k)) entry.sources.set(k, s);
          }
          for (const sk of sceneKinds) entry.sceneKinds.add(sk);

          edges.push({
            from: `object:${sceneName}/${uniqueObjKey}`,
            to: archId,
            kind: "instantiates",
            confidence: "introspected",
            source: relScene,
          });
        }

        nodes.push({
          id: `object:${sceneName}/${uniqueObjKey}`,
          kind: "object",
          name: sn.name ?? sn.id,
          scene: sceneName,
          ...(doc.kind ? { sceneKind: doc.kind } : {}),
          ...(sn.kind ? { nodeKind: sn.kind } : {}),
          ...(archId ? { archetype: archId } : {}),
          source: relScene,
        });
      }
    }

    coverage.push({
      source: "content/scenes/*.scene.json",
      status: "extracted",
      count: totalSceneObjects,
      details: `${totalSceneObjects} scene nodes harvested across ${sceneFiles.length} scenes (${realizedSceneObjects} realized into ${archetypeAccum.size} archetypes)`,
    });
  }

  for (const [archId, entry] of archetypeAccum) {
    const primarySource =
      [...entry.sources.values()].sort()[0] ?? "packages/engine-core/src/scene-spawn.ts:1";
    nodes.push({
      id: archId,
      kind: "archetype",
      name: [...entry.sceneKinds].sort().join("+") || archId,
      components: entry.components,
      objectCount: entry.objectCount,
      source: primarySource,
    });
    for (const compName of entry.components) {
      const realizationSrc = entry.sources.get(compName) ?? primarySource;
      edges.push({
        from: archId,
        to: `component:${compName}`,
        kind: "hasComponent",
        confidence: "inferred",
        source: realizationSrc,
      });
      edges.push({
        from: archId,
        to: `component:${compName}`,
        kind: "realizes",
        confidence: "inferred",
        source: realizationSrc,
      });
    }
  }

  // Honest coverage summary for settlement manifests (these define procedural structures & NPCs without static ECS component arrays)
  const settlementsDir = resolve(repoRoot, "content/settlements");
  if (existsSync(settlementsDir)) {
    const settlementFiles = readdirSync(settlementsDir)
      .filter((f) => f.endsWith(".settlement.json") || f === "places.json")
      .sort();
    let structTotal = 0;
    let npcTotal = 0;
    let placeTotal = 0;
    for (const sfName of settlementFiles) {
      const abs = join(settlementsDir, sfName);
      trackedSourceFiles.add(toPosixPath(relative(repoRoot, abs)));
      const data = JSON.parse(readFileSync(abs, "utf8")) as {
        structures?: unknown[];
        places?: unknown[];
        occupancy?: { npcs?: unknown[] };
      };
      if (Array.isArray(data.structures)) structTotal += data.structures.length;
      if (Array.isArray(data.places)) placeTotal += data.places.length;
      if (Array.isArray(data.occupancy?.npcs)) npcTotal += data.occupancy!.npcs.length;
    }
    if (settlementFiles.length > 0) {
      coverage.push({
        source: "content/settlements/*.settlement.json",
        status: "summary-only",
        count: settlementFiles.length,
        details: `${settlementFiles.length} manifests (${structTotal} structures, ${npcTotal} NPCs, ${placeTotal} places); ECS instances realize dynamically at runtime via scenes + ResidentSystem`,
      });
    }
  }

  // Track roles.ts itself so allowlist/role changes invalidate sourceHashes
  const rolesPath = resolve(repoRoot, "packages/graphify/src/roles.ts");
  if (existsSync(rolesPath)) {
    trackedSourceFiles.add("packages/graphify/src/roles.ts");
  }

  const sourceHashes: Record<string, string> = {};
  for (const rel of trackedSourceFiles) {
    const abs = resolve(repoRoot, rel);
    if (existsSync(abs)) {
      sourceHashes[rel] = sha256File(abs);
    }
  }

  const graph = finalizeGraph({
    builtFromCommit,
    sourceHashes,
    coverage,
    unresolved: ast.unresolved,
    nodes,
    edges,
  });

  // Stage 4: Validate all §7 invariants + H3 allowlist ratchet
  return validateGraph(graph, {
    introspected,
    roster: ast.roster,
    declaredDeclarations: ast.declaredDeclarations,
    enforceAllowlistRatchet:
      options.enforceAllowlistRatchet ?? ast.roster.length > 0,
  });
}
