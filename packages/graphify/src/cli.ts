#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { harvest } from "./harvest.js";
import {
  EcsGraphSchema,
  canonicalJson,
  type EcsGraph,
  type GraphEdge,
  type GraphNode,
} from "./schema.js";

const DEFAULT_OUT = "content/graph/ecs-graph.json";

export function loadGraph(filePath: string): EcsGraph {
  const abs = resolve(filePath);
  if (!existsSync(abs)) {
    throw new Error(`Graph artifact not found at ${abs}. Run \`npm run graphify:build\` first.`);
  }
  const raw = JSON.parse(readFileSync(abs, "utf8")) as unknown;
  return EcsGraphSchema.parse(raw);
}

const WHY_KIND_PRIORITY: Record<GraphNode["kind"], number> = {
  component: 0,
  field: 1,
  system: 2,
  object: 3,
  archetype: 4,
  verb: 5,
  widget: 6,
  module: 7,
};

/**
 * Resolve an arbitrary id or friendly name (e.g. `component:Health`, `Health`,
 * `Health.current`, `IntentSystem`, `intent`) to a graph node.
 */
export function resolveGraphNode(graph: EcsGraph, query: string): GraphNode | undefined {
  const exact = graph.nodes.find((n) => n.id === query);
  if (exact) return exact;

  const lower = query.toLowerCase();
  const candidates: GraphNode[] = [];
  for (const n of graph.nodes) {
    if (n.name.toLowerCase() === lower) candidates.push(n);
    else if (n.kind === "system" && (n.simName?.toLowerCase() === lower || n.className?.toLowerCase() === lower)) {
      candidates.push(n);
    } else if (n.kind === "field" && `${n.component}.${n.name}`.toLowerCase() === lower) {
      candidates.push(n);
    }
  }
  candidates.sort((a, b) => WHY_KIND_PRIORITY[a.kind] - WHY_KIND_PRIORITY[b.kind]);
  return candidates[0];
}

function fmtEdge(edge: GraphEdge, peer: string): string {
  return `${peer} [${edge.confidence}] (${edge.source})`;
}

/** Produce a concise human-readable architectural breakdown for any node id/query. */
export function explainWhy(graph: EcsGraph, query: string): string {
  const node = resolveGraphNode(graph, query);
  if (!node) {
    throw new Error(`No node matches "${query}" in ecs-graph.json.`);
  }

  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const outgoing = graph.edges.filter((e) => e.from === node.id);
  const incoming = graph.edges.filter((e) => e.to === node.id);
  const lines: string[] = [];

  lines.push(`${node.id} (${node.kind})`);
  lines.push(`  source: ${node.source}`);

  if (node.kind === "component") {
    lines.push(
      `  schema: sab=${node.sab}, tag=${node.tag}, addable=${Boolean(node.addable)}` +
        (node.componentId !== undefined ? `, componentId=${node.componentId}` : "") +
        `, fields=${node.fields.length}`,
    );
    if (node.fields.length > 0) {
      lines.push(
        `  fields: ${node.fields.map((f) => `${f.name}:${f.type}${f.arrayLength ? `[${f.arrayLength}]` : ""}`).join(", ")}`,
      );
    }

    const fieldIds = new Set(node.fields.map((f) => `field:${node.name}.${f.name}`));
    const relIncoming = graph.edges.filter(
      (e) => e.to === node.id || fieldIds.has(e.to),
    );
    const readers = relIncoming.filter((e) => e.kind === "reads");
    const writers = relIncoming.filter((e) => e.kind === "writes");
    const excluders = incoming.filter((e) => e.kind === "excludes");
    const archetypes = incoming.filter((e) => e.kind === "hasComponent" || e.kind === "realizes");
    const summons = outgoing.filter((e) => e.kind === "summons");

    lines.push(`  readers (${readers.length}):`);
    for (const e of readers) {
      const targetSuffix = e.to !== node.id ? ` -> ${e.to}` : "";
      const sys = nodeMap.get(e.from);
      const roleTag = sys?.kind === "system" ? ` {${sys.role}}` : "";
      lines.push(`    - ${e.from}${roleTag}${targetSuffix} [${e.confidence}] (${e.source})`);
    }
    lines.push(`  writers (${writers.length}):`);
    for (const e of writers) {
      const targetSuffix = e.to !== node.id ? ` -> ${e.to}` : "";
      const sys = nodeMap.get(e.from);
      const roleTag = sys?.kind === "system" ? ` {${sys.role}}` : "";
      lines.push(`    - ${e.from}${roleTag}${targetSuffix} [${e.confidence}] (${e.source})`);
    }
    if (excluders.length > 0) {
      lines.push(`  excluded by: ${excluders.map((e) => fmtEdge(e, e.from)).join("; ")}`);
    }
    if (archetypes.length > 0) {
      const uniqueArch = [...new Set(archetypes.map((e) => e.from))].sort();
      lines.push(`  archetypes (${uniqueArch.length}): ${uniqueArch.join(", ")}`);
    }
    if (summons.length > 0) {
      lines.push(`  summons widgets: ${summons.map((e) => fmtEdge(e, e.to)).join("; ")}`);
    }
  } else if (node.kind === "field") {
    lines.push(
      `  parent: component:${node.component}, type=${node.fieldType}, sab=${node.sab}` +
        (node.arrayLength ? `, arrayLength=${node.arrayLength}` : "") +
        (node.protocolRows?.length ? `, protocolRows=[${node.protocolRows.join(", ")}]` : ""),
    );
    const readers = incoming.filter((e) => e.kind === "reads");
    const writers = incoming.filter((e) => e.kind === "writes");
    lines.push(`  readers (${readers.length}):`);
    for (const e of readers) lines.push(`    - ${fmtEdge(e, e.from)}`);
    lines.push(`  writers (${writers.length}):`);
    for (const e of writers) lines.push(`    - ${fmtEdge(e, e.from)}`);
  } else if (node.kind === "system") {
    lines.push(
      `  role: ${node.role}, declared=${node.declared}` +
        (node.module ? `, module=${node.module}` : "") +
        (node.tickIndex !== undefined ? `, tickIndex=${node.tickIndex}` : "") +
        (node.className ? `, class=${node.className}` : "") +
        (node.simName ? `, simName=${node.simName}` : ""),
    );
    const reads = outgoing.filter((e) => e.kind === "reads");
    const writes = outgoing.filter((e) => e.kind === "writes");
    const excludes = outgoing.filter((e) => e.kind === "excludes");
    const touchedBy = incoming.filter((e) => e.kind === "touches");
    lines.push(`  reads (${reads.length}):`);
    for (const e of reads) lines.push(`    - ${fmtEdge(e, e.to)}`);
    lines.push(`  writes (${writes.length}):`);
    for (const e of writes) lines.push(`    - ${fmtEdge(e, e.to)}`);
    if (excludes.length > 0) {
      lines.push(`  excludes (${excludes.length}):`);
      for (const e of excludes) lines.push(`    - ${fmtEdge(e, e.to)}`);
    }
    if (touchedBy.length > 0) {
      lines.push(`  verbs: ${touchedBy.map((e) => e.from).join(", ")}`);
    }
  } else if (node.kind === "object" || node.kind === "archetype") {
    let comps: string[] = [];
    if (node.kind === "object") {
      lines.push(
        `  scene: ${node.scene}` +
          (node.sceneKind ? ` (${node.sceneKind})` : "") +
          (node.nodeKind ? `, nodeKind=${node.nodeKind}` : "") +
          (node.archetype ? `, archetype=${node.archetype}` : ""),
      );
      if (node.archetype) {
        const arch = nodeMap.get(node.archetype);
        if (arch?.kind === "archetype") comps = arch.components;
      }
    } else {
      lines.push(`  name: ${node.name}, objectCount=${node.objectCount}`);
      comps = node.components;
    }
    lines.push(`  components (${comps.length}): ${comps.join(", ") || "(none)"}`);
    if (comps.length > 0) {
      const compIdSet = new Set(comps.map((c) => `component:${c}`));
      const simTouching = new Map<string, Set<string>>();
      for (const e of graph.edges) {
        if (e.kind !== "reads" && e.kind !== "writes" && e.kind !== "excludes") continue;
        const targetComp = e.to.startsWith("field:")
          ? `component:${e.to.slice(6).split(".")[0]}`
          : e.to;
        if (!compIdSet.has(targetComp)) continue;
        const sys = nodeMap.get(e.from);
        if (!sys || sys.kind !== "system" || sys.role !== "simulation") continue;
        const ops = simTouching.get(sys.id) ?? new Set<string>();
        ops.add(`${e.kind}:${e.to}`);
        simTouching.set(sys.id, ops);
      }
      lines.push(`  simulation systems touching components (${simTouching.size}):`);
      for (const sid of [...simTouching.keys()].sort()) {
        lines.push(`    - ${sid}: ${[...simTouching.get(sid)!].sort().join(", ")}`);
      }
    }
  } else {
    lines.push(`  outgoing (${outgoing.length}):`);
    for (const e of outgoing) lines.push(`    - ${e.kind} -> ${fmtEdge(e, e.to)}`);
    lines.push(`  incoming (${incoming.length}):`);
    for (const e of incoming) lines.push(`    - ${e.from} ${e.kind} [${e.confidence}] (${e.source})`);
  }

  return lines.join("\n");
}

/** Shape of the artifact as the `--check` failure path reads it: by key, not by schema. */
interface CheckedArtifact {
  readonly meta?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

const MAX_NAMED_FILES = 8;

const shortHash = (value: unknown): string =>
  typeof value === "string" && value.length > 12 ? `${value.slice(0, 12)}…` : String(value);

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** `label (n): a, b, c, and 4 more`, or nothing when the list is empty. */
function namedFiles(label: string, files: readonly string[]): string[] {
  if (files.length === 0) return [];
  const shown = files.slice(0, MAX_NAMED_FILES);
  const rest = files.length - shown.length;
  return [`    ${label} (${files.length}): ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`];
}

/**
 * Explain why the byte comparison failed, in terms the reader can act on.
 *
 * `--check` compares the whole file, so editing any file in `meta.sourceHashes`
 * fails it even though the graph itself — and so `meta.graphHash` — is
 * unchanged. Printing the hash alone then showed the same string twice and read
 * like a bug in the checker rather than a stale artifact.
 */
export function whatDiffers(existingText: string, expectedText: string): string {
  let existing: CheckedArtifact;
  let expected: CheckedArtifact;
  try {
    existing = JSON.parse(existingText) as CheckedArtifact;
    expected = JSON.parse(expectedText) as CheckedArtifact;
  } catch {
    return "  The on-disk artifact is not valid JSON.\n";
  }

  const lines: string[] = [];
  const oldMeta = asRecord(existing.meta);
  const newMeta = asRecord(expected.meta);

  if (!sameValue(oldMeta.graphHash, newMeta.graphHash)) {
    lines.push(
      `  The graph changed: meta.graphHash ${shortHash(oldMeta.graphHash)} -> ${shortHash(newMeta.graphHash)}.`,
    );
    const oldCounts = asRecord(oldMeta.counts);
    const newCounts = asRecord(newMeta.counts);
    const moved = [...new Set([...Object.keys(oldCounts), ...Object.keys(newCounts)])]
      .sort()
      .filter((key) => !sameValue(oldCounts[key], newCounts[key]))
      .map((key) => `${key} ${JSON.stringify(oldCounts[key]) ?? "missing"} -> ${JSON.stringify(newCounts[key]) ?? "missing"}`);
    if (moved.length > 0) lines.push(`    counts: ${moved.join(", ")}`);
  } else {
    lines.push(`  The graph is unchanged: meta.graphHash is ${shortHash(newMeta.graphHash)} on both sides.`);
  }

  const oldSources = asRecord(oldMeta.sourceHashes);
  const newSources = asRecord(newMeta.sourceHashes);
  if (!sameValue(oldSources, newSources)) {
    const changed: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];
    for (const file of new Set([...Object.keys(oldSources), ...Object.keys(newSources)]).values()) {
      const had = file in oldSources;
      const has = file in newSources;
      if (had && has) {
        if (!sameValue(oldSources[file], newSources[file])) changed.push(file);
      } else if (has) {
        added.push(file);
      } else {
        removed.push(file);
      }
    }
    lines.push("  Tracked source files moved (meta.sourceHashes):");
    lines.push(...namedFiles("edited", changed.sort()));
    lines.push(...namedFiles("new", added.sort()));
    lines.push(...namedFiles("gone", removed.sort()));
  }

  const otherMeta = [...new Set([...Object.keys(oldMeta), ...Object.keys(newMeta)])]
    .sort()
    .filter((key) => key !== "graphHash" && key !== "counts" && key !== "sourceHashes")
    .filter((key) => !sameValue(oldMeta[key], newMeta[key]));
  if (otherMeta.length > 0) lines.push(`  Other meta keys differ: ${otherMeta.join(", ")}.`);

  const otherTop = [...new Set([...Object.keys(existing), ...Object.keys(expected)])]
    .sort()
    .filter((key) => key !== "meta")
    .filter((key) => !sameValue(existing[key], expected[key]));
  if (otherTop.length > 0) lines.push(`  Top-level keys differ: ${otherTop.join(", ")}.`);

  if (lines.length === 1 && lines[0]?.startsWith("  The graph is unchanged")) {
    lines.push("  No part of the artifact differs by value, so this is a formatting difference; rebuilding fixes it.");
  }
  return `${lines.join("\n")}\n`;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

export function runCli(argv: readonly string[]): number {
  const args = [...argv];
  const repoRoot = resolve(parseFlag(args, "--repo") ?? process.cwd());

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    process.stdout.write(
      [
        "Usage:",
        "  graphify build [--out content/graph/ecs-graph.json] [--repo .]",
        "  graphify --check [--in content/graph/ecs-graph.json] [--repo .]",
        "  graphify --why <nodeId-or-name> [--in content/graph/ecs-graph.json]",
      ].join("\n") + "\n",
    );
    return args.length === 0 ? 1 : 0;
  }

  if (args.includes("--why")) {
    const query = parseFlag(args, "--why");
    if (!query) {
      process.stderr.write("--why requires a node id or name.\n");
      return 1;
    }
    const inPath = resolve(repoRoot, parseFlag(args, "--in") ?? DEFAULT_OUT);
    const graph = loadGraph(inPath);
    process.stdout.write(`${explainWhy(graph, query)}\n`);
    return 0;
  }

  if (args.includes("--check") || args[0] === "check") {
    const inPath = resolve(repoRoot, parseFlag(args, "--in") ?? parseFlag(args, "--out") ?? DEFAULT_OUT);
    if (!existsSync(inPath)) {
      process.stderr.write(`graphify --check FAIL: missing artifact at ${inPath}\n`);
      return 1;
    }
    const existingBuf = readFileSync(inPath);
    const existingText = existingBuf.toString("utf8");
    let parsedExisting: { meta?: { builtFromCommit?: unknown; graphHash?: unknown } };
    try {
      parsedExisting = JSON.parse(existingText) as {
        meta?: { builtFromCommit?: unknown; graphHash?: unknown };
      };
    } catch {
      process.stderr.write(`graphify --check FAIL: artifact ${inPath} is not valid JSON.\n`);
      return 1;
    }
    const existingCommit = parsedExisting.meta?.builtFromCommit;
    if (typeof existingCommit !== "string" || existingCommit.length === 0) {
      process.stderr.write(
        `graphify --check FAIL: artifact ${inPath} has missing or empty meta.builtFromCommit.\n` +
          `  Run \`npm run graphify:build\` (or \`node packages/graphify/dist/src/cli.js build\`) to regenerate.\n`,
      );
      return 1;
    }

    const fresh = harvest({ repoRoot, builtFromCommit: existingCommit });
    const expectedText = canonicalJson(fresh);
    const expectedBuf = Buffer.from(expectedText, "utf8");
    if (!existingBuf.equals(expectedBuf)) {
      process.stderr.write(
        `graphify --check FAIL: artifact ${inPath} is out of date.\n` +
          whatDiffers(existingText, expectedText) +
          `  Run \`npm run graphify:build\` (or \`node packages/graphify/dist/src/cli.js build\`) to regenerate.\n`,
      );
      return 1;
    }
    process.stdout.write(
      `graphify --check OK: ${fresh.meta.counts.nodes} nodes, ${fresh.meta.counts.edges} edges, ` +
        `declared=${fresh.meta.counts.declaredSystems}/${fresh.meta.counts.simulationSystems} sim systems, ` +
        `unresolved=${fresh.meta.counts.unresolved}, hash=${fresh.meta.graphHash.slice(0, 12)} (byte-identical)\n`,
    );
    return 0;
  }

  if (args[0] === "build") {
    const outPath = resolve(repoRoot, parseFlag(args, "--out") ?? DEFAULT_OUT);
    const graph = harvest({ repoRoot });
    mkdirSync(dirname(outPath), { recursive: true });
    const jsonText = canonicalJson(graph);
    writeFileSync(outPath, jsonText, "utf8");
    process.stdout.write(
      `graphify build OK: wrote ${outPath} (${graph.meta.counts.nodes} nodes, ` +
        `${graph.meta.counts.edges} edges, declared=${graph.meta.counts.declaredSystems}/` +
        `${graph.meta.counts.simulationSystems} sim systems, unresolved=${graph.meta.counts.unresolved}, ` +
        `hash=${graph.meta.graphHash.slice(0, 12)})\n`,
    );
    return 0;
  }

  process.stderr.write(`Unknown graphify arguments: ${args.join(" ")}\n`);
  return 1;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url.toLowerCase() === pathToFileURL(resolve(process.argv[1])).href.toLowerCase();

if (isEntrypoint) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
