import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EcsGraphSchema,
  FILE_LINE_RE,
  archetypeId,
  assertDeterministicBytes,
  canonicalJson,
  explainWhy,
  harvest,
  loadGraph,
  runCli,
  validateGraph,
  type EcsGraph,
} from "../src/index.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
// Works from both src/test (if ever run via loader) and dist/test
const PKG_ROOT = resolve(THIS_DIR, "..", "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");
const CLI_PATH = resolve(PKG_ROOT, "dist/src/cli.js");

function makeSyntheticRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "graphify-fixture-"));
  const req = createRequire(import.meta.url);
  const bitecsUrl = pathToFileURL(req.resolve("bitecs")).href;

  mkdirSync(join(dir, "packages/engine-core/dist/src"), { recursive: true });
  mkdirSync(join(dir, "packages/engine-core/src"), { recursive: true });
  mkdirSync(join(dir, "content/scenes"), { recursive: true });

  writeFileSync(
    join(dir, "packages/engine-core/package.json"),
    JSON.stringify({ name: "@mmo-engine/engine-core", version: "0.1.0", type: "module" }),
    "utf8",
  );

  // Compiled bitECS runtime module (imported by child introspect-runner)
  writeFileSync(
    join(dir, "packages/engine-core/dist/src/components.js"),
    `
import { defineComponent, Types } from ${JSON.stringify(bitecsUrl)};
export const COMPONENT_IDS = { Pos: 0, Bag: 1, Frozen: 2 };
export const Pos = defineComponent({ x: Types.f32, y: Types.f32 });
export const Bag = defineComponent({ slots: [Types.ui8, 4] });
export const Frozen = defineComponent();
`,
    "utf8",
  );

  writeFileSync(
    join(dir, "packages/engine-core/src/components.ts"),
    `
export const Pos = { x: [], y: [] };
export const Bag = { slots: [] };
export const Frozen = {};
`,
    "utf8",
  );

  // Synthetic systems demonstrating declared, extracted (read, write, compound +=, Not),
  // query-only inferred, and dynamic unresolved tracking with file:line.
  writeFileSync(
    join(dir, "packages/engine-core/src/systems.ts"),
    `
import { defineQuery, hasComponent, Not } from "bitecs";
import { Pos, Bag, Frozen } from "./components.js";

export interface SimSystem { readonly name: string; }

export class AlphaSystem implements SimSystem {
  readonly name = "alpha";
  readonly access = {
    system: "alpha",
    reads: [{ component: "Pos", fields: ["x"] }, "Frozen"],
    writes: [{ component: "Pos", fields: ["y"] }],
    excludes: ["Frozen"],
  };
}

export class BetaSystem implements SimSystem {
  readonly name = "beta";
  private readonly query = defineQuery([Pos, Not(Frozen)]);
  step(ecs: unknown, dynComp: unknown): void {
    const eids = this.query(ecs);
    for (const e of eids) {
      Pos.y[e] += Pos.x[e];
      hasComponent(ecs, dynComp, e);
    }
  }
}

export class GammaSystem implements SimSystem {
  readonly name = "gamma";
  private readonly query = defineQuery([Bag]);
  step(ecs: unknown): void {
    this.query(ecs);
  }
}
`,
    "utf8",
  );

  // Synthetic scene realization (S8) + scene JSON objects (S7)
  writeFileSync(
    join(dir, "packages/engine-core/src/scene-spawn.ts"),
    `
export function spawn(node: { components?: { Structure?: unknown; Collider?: unknown } }) {
  if (node.components?.Structure) return ["Transform", "AssetRef"];
  if (node.components?.Collider) return ["Transform", "BodyConfig"];
  return [];
}
`,
    "utf8",
  );

  writeFileSync(
    join(dir, "content/scenes/demo.scene.json"),
    JSON.stringify({
      name: "demo",
      kind: "arena",
      nodes: [
        { id: "a", name: "Rock A", kind: "object", components: { Collider: { shape: "box" } } },
        { id: "b", name: "Rock B", kind: "object", components: { Collider: { shape: "box" } } },
      ],
    }),
    "utf8",
  );

  return dir;
}

test("synthetic fixture: runtime introspection + AST extraction + scene archetypes + unresolved file:line", () => {
  const dir = makeSyntheticRepo();
  try {
    const graph = harvest({
      repoRoot: dir,
      introspectModules: [
        {
          modulePath: "packages/engine-core/dist/src/components.js",
          relSource: "packages/engine-core/src/components.ts",
        },
      ],
      addComponentPath: "packages/engine-core/dist/src/missing-add.js",
      builtFromCommit: "test-fixture",
    });

    const parsed = EcsGraphSchema.parse(graph);
    assert.equal(parsed.meta.schemaVersion, 1);
    assert.equal(parsed.meta.builtFromCommit, "test-fixture");

    // 3 introspected components: Pos, Bag, Frozen
    const compNames = parsed.nodes
      .filter((n) => n.kind === "component")
      .map((n) => n.name)
      .sort();
    assert.deepEqual(compNames, ["Bag", "Frozen", "Pos"]);

    const bag = parsed.nodes.find((n) => n.id === "component:Bag");
    assert.ok(bag && bag.kind === "component");
    assert.equal(bag.tag, false);
    assert.equal(bag.fields[0]?.name, "slots");
    assert.equal(bag.fields[0]?.arrayLength, 4);

    const frozen = parsed.nodes.find((n) => n.id === "component:Frozen");
    assert.ok(frozen && frozen.kind === "component");
    assert.equal(frozen.tag, true);

    // Non-existent scene component mappings don't emit broken components; inspect objects present
    assert.equal(parsed.nodes.filter((n) => n.kind === "object").length, 2);

    // Verify dynamic hasComponent was recorded in meta.unresolved with POSIX file:line
    assert.equal(parsed.meta.unresolved.length, 1);
    assert.match(parsed.meta.unresolved[0]!.site, FILE_LINE_RE);
    assert.ok(parsed.meta.unresolved[0]!.site.startsWith("packages/engine-core/src/systems.ts:"));

    // Verify determinism on synthetic tree
    const second = harvest({
      repoRoot: dir,
      introspectModules: [
        {
          modulePath: "packages/engine-core/dist/src/components.js",
          relSource: "packages/engine-core/src/components.ts",
        },
      ],
      addComponentPath: "packages/engine-core/dist/src/missing-add.js",
      builtFromCommit: "test-fixture",
    });
    assertDeterministicBytes(parsed, second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archetypeId is pure over component order and duplicates", () => {
  const a = archetypeId(["Velocity", "Transform", "BodyConfig", "Transform"]);
  const b = archetypeId(["BodyConfig", "Transform", "Velocity"]);
  assert.equal(a, b);
  assert.match(a, /^archetype:[a-f0-9]{12}$/);
});

test("validateGraph rejects bad edge endpoints, bad declared fields, bad unresolved sites, and H3 ratchet violations", () => {
  const realGraph = loadGraph(resolve(REPO_ROOT, "content/graph/ecs-graph.json"));

  // 1. Dangling edge endpoint
  const badEdgeGraph: EcsGraph = {
    ...realGraph,
    edges: [
      ...realGraph.edges,
      {
        from: "system:intent",
        to: "component:DoesNotExist",
        kind: "reads",
        confidence: "inferred",
        source: "test:1",
      },
    ],
  };
  assert.throws(() => validateGraph(badEdgeGraph), /dangling edge\.to/);

  // 2. Bad unresolved site (missing :line)
  const badUnresolvedGraph: EcsGraph = {
    ...realGraph,
    meta: {
      ...realGraph.meta,
      unresolved: [
        { site: "packages/engine-core/src/systems.ts", reason: "missing line number" },
      ],
    },
  };
  assert.throws(() => validateGraph(badUnresolvedGraph), /file:line/);

  // 3. Bad declared field via ValidateContext
  assert.throws(
    () =>
      validateGraph(realGraph, {
        introspected: {
          components: realGraph.nodes
            .filter((n): n is Extract<EcsGraph["nodes"][number], { kind: "component" }> => n.kind === "component")
            .map((c) => ({
              name: c.name,
              componentId: c.componentId,
              sab: c.sab,
              tag: c.tag,
              addable: Boolean(c.addable),
              source: c.source,
              fields: c.fields.map((f) => ({ name: f.name, type: f.type, sab: c.sab })),
            })),
          addableNames: [],
          componentIds: {},
        },
        declaredDeclarations: [
          {
            rosterName: "intent",
            expectedSimName: "intent",
            declaration: {
              system: "intent",
              reads: [{ component: "PlayerIntent", fields: ["nonExistentField"] }],
              writes: [],
              excludes: [],
              source: "test.ts:10",
            },
          },
        ],
      }),
    /non-existent field "PlayerIntent\.nonExistentField"/,
  );

  // 4. H3 allowlist ratchet failure when a new unannotated simulation system is introduced
  assert.throws(
    () =>
      validateGraph(realGraph, {
        enforceAllowlistRatchet: true,
        roster: [
          {
            rosterName: "brand-new-unannotated-sim",
            moduleName: "combat",
            tickIndex: 99,
            simName: "brand-new-unannotated-sim",
            role: "simulation",
            declared: false,
          },
        ],
      }),
    /H3 ratchet violation/,
  );
});

test("real repository harvest satisfies all §7 invariants, H3 ratchet, and two-run byte determinism", () => {
  const first = harvest({ repoRoot: REPO_ROOT });
  const second = harvest({ repoRoot: REPO_ROOT });
  assertDeterministicBytes(first, second);

  // Verify core components & special fields (SAB array Body.hp, tag God, etc.)
  const compIds = new Set(first.nodes.filter((n) => n.kind === "component").map((n) => n.name));
  for (const required of ["Transform", "Velocity", "PlayerIntent", "Health", "Body", "Injury", "Mana", "God"]) {
    assert.ok(compIds.has(required), `missing component ${required}`);
  }

  const bodyHp = first.nodes.find((n) => n.id === "field:Body.hp");
  assert.ok(bodyHp && bodyHp.kind === "field");
  assert.equal(bodyHp.arrayLength, 15);
  assert.equal(bodyHp.sab, true);

  // Verify H3 declared systems
  for (const sysName of ["intent", "character", "integrate", "collider", "physics"]) {
    const sys = first.nodes.find((n) => n.id === `system:${sysName}`);
    assert.ok(sys && sys.kind === "system", `missing system:${sysName}`);
    assert.equal(sys.declared, true, `expected system:${sysName} declared=true`);
    assert.equal(sys.role, "simulation");
  }
  assert.equal(first.meta.counts.declaredSystems, 5);
  assert.equal(first.meta.counts.simulationSystems, 32);

  // Every unresolved entry must use POSIX slashes and file:line
  for (const u of first.meta.unresolved) {
    assert.match(u.site, FILE_LINE_RE);
    assert.ok(!u.site.includes("\\"), `unresolved site contains backslash: ${u.site}`);
  }
});

test("CLI --check passes on committed artifact and fails cleanly on drift or missing file", () => {
  const checkOut = execFileSync(process.execPath, [CLI_PATH, "--check"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.match(checkOut, /graphify --check OK:/);
  assert.match(checkOut, /byte-identical/);

  // Drift failure & HEAD-movement check on temp copies
  const driftDir = mkdtempSync(join(tmpdir(), "graphify-drift-"));
  try {
    const artifact = readFileSync(resolve(REPO_ROOT, "content/graph/ecs-graph.json"), "utf8");
    const parsedArtifact = JSON.parse(artifact) as EcsGraph;

    // Passes when graph/sourceHashes are current even if builtFromCommit predates current HEAD
    const movedHeadPath = join(driftDir, "moved-head.json");
    const movedHead = harvest({ repoRoot: REPO_ROOT, builtFromCommit: "0123456789abcdef0123456789abcdef01234567" });
    writeFileSync(movedHeadPath, canonicalJson(movedHead), "utf8");
    assert.equal(runCli(["--check", "--in", movedHeadPath, "--repo", REPO_ROOT]), 0);

    // Fails cleanly when meta.builtFromCommit is empty/missing
    const emptyCommitPath = join(driftDir, "empty-commit.json");
    writeFileSync(
      emptyCommitPath,
      canonicalJson({ ...parsedArtifact, meta: { ...parsedArtifact.meta, builtFromCommit: "" } }),
      "utf8",
    );
    assert.equal(runCli(["--check", "--in", emptyCommitPath, "--repo", REPO_ROOT]), 1);

    // Fails when graphHash/content drifts
    const mutatedPath = join(driftDir, "ecs-graph.json");
    writeFileSync(
      mutatedPath,
      canonicalJson({ ...parsedArtifact, meta: { ...parsedArtifact.meta, graphHash: "0".repeat(64) } }),
      "utf8",
    );
    const code = runCli(["--check", "--in", mutatedPath, "--repo", REPO_ROOT]);
    assert.equal(code, 1);

    const missingCode = runCli(["--check", "--in", join(driftDir, "does-not-exist.json"), "--repo", REPO_ROOT]);
    assert.equal(missingCode, 1);
  } finally {
    rmSync(driftDir, { recursive: true, force: true });
  }
});

test("CLI --why answers component, field, system, and scene object queries", () => {
  const outComp = execFileSync(process.execPath, [CLI_PATH, "--why", "component:Health"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.match(outComp, /component:Health \(component\)/);
  assert.match(outComp, /system:character/);
  assert.match(outComp, /\[declared\]/);

  const graph = loadGraph(resolve(REPO_ROOT, "content/graph/ecs-graph.json"));
  const sysText = explainWhy(graph, "IntentSystem");
  assert.match(sysText, /system:intent \(system\)/);
  assert.match(sysText, /field:Velocity\.lx \[declared\]/);

  // Bare name prefers system over module, while exact id still resolves module
  assert.match(explainWhy(graph, "intent"), /^system:intent \(system\)/);
  assert.match(explainWhy(graph, "module:intent"), /^module:intent \(module\)/);

  const fieldText = explainWhy(graph, "field:BodyConfig.shapeKind");
  assert.match(fieldText, /parent: component:BodyConfig/);
  assert.match(fieldText, /system:collider/);

  const sampleObject = graph.nodes.find((n) => n.kind === "object" && n.archetype);
  assert.ok(sampleObject, "expected at least one realized scene object in graph");
  const objText = explainWhy(graph, sampleObject.id);
  assert.match(objText, /simulation systems touching components/);

  assert.throws(() => explainWhy(graph, "component:NonExistentWidget"), /No node matches/);
});
