/**
 * The gate for ES2: with no `game.json` and no `MMO_*` variable set, every
 * path `@mmo-engine/sdk` resolves is the constant the engine already had.
 *
 * Each case imports the real constant rather than restating its path, so a
 * constant that moves fails here instead of silently disagreeing with the
 * manifest. The few seams whose default lives inline in `server.ts` or in
 * a package engine-core does not depend on are checked against that file's
 * own text, the same way `rules-hook-overrides.test.ts` guards the hook
 * call sites.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { DEFAULT_CRAFTING_FILE } from "@mmo-engine/crafting";
import { ENGINE_ROOT, SEAMS, SEAM_KEYS, openGameProject, type GameProject, type SeamKey } from "@mmo-engine/sdk";
import { DEFAULT_COMBAT_FILE } from "../src/combat-content.js";
import { DEFAULT_DUNGEON_CONTENT } from "../src/dungeons/content.js";
import { DEFAULT_PCG_ASSETS } from "../src/pcg/boot.js";
import { DEFAULT_BIOME_REGISTRY } from "../src/procgen/biome-registry.js";
import { DEFAULT_NATURAL_WEAPONS } from "../src/procgen/wildlife-creatures.js";
import { DEFAULT_WILDLIFE_TABLE } from "../src/procgen/wildlife-table.js";
import { DEFAULT_ECOLOGY_PLAN } from "../src/procgen/world-populator.js";
import { DEFAULT_QUEST_DIR } from "../src/quests/content.js";
import { DEFAULT_RULES_DIR } from "../src/rules/boot.js";
import { DEFAULT_SCALE_FILE } from "../src/scale.js";
import { DEFAULT_PREFABS_DIR, DEFAULT_SCENES_DIR } from "../src/scene-spawn.js";
import { DEFAULT_SERVER_SETTINGS_DIR } from "../src/server-settings.js";
import { DEFAULT_SPECIES_FILE } from "../src/species-roster.js";

/** This test runs from packages/engine-core/dist/test. */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const source = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

/** No manifest anywhere, no variables: the engine as it was. */
const bare = (): GameProject => openGameProject({ env: {}, cwd: REPO_ROOT, exists: () => false });

/** The engine's own constant for each seam that exports one. */
const CONSTANTS: Partial<Record<SeamKey, string>> = {
  rulesDir: DEFAULT_RULES_DIR,
  scenesDir: DEFAULT_SCENES_DIR,
  prefabsDir: DEFAULT_PREFABS_DIR,
  serverSettingsDir: DEFAULT_SERVER_SETTINGS_DIR,
  combatFile: DEFAULT_COMBAT_FILE,
  craftingFile: DEFAULT_CRAFTING_FILE,
  questsDir: DEFAULT_QUEST_DIR,
  dungeonsDir: DEFAULT_DUNGEON_CONTENT,
  speciesFile: DEFAULT_SPECIES_FILE,
  scaleFile: DEFAULT_SCALE_FILE,
  pcgAssetsDir: DEFAULT_PCG_ASSETS,
  biomesFile: DEFAULT_BIOME_REGISTRY,
  ecologyFile: DEFAULT_ECOLOGY_PLAN,
  wildlifeTableFile: DEFAULT_WILDLIFE_TABLE,
  naturalWeaponsFile: DEFAULT_NATURAL_WEAPONS,
};

describe("ES2: the resolver's defaults are the engine's own", () => {
  const project = bare();

  for (const [key, constant] of Object.entries(CONSTANTS) as [SeamKey, string][]) {
    it(`${key} is the engine's constant`, () => {
      assert.equal(project.paths[key], constant);
      assert.equal(project.sources[key], "default");
    });
  }

  it("covers the engine's exported path constants: a new one has to be added here", () => {
    // Every DEFAULT_* constant in engine-core's sources that resolves to a
    // content path. If this list grows, the seam table and CONSTANTS above
    // grow with it rather than the engine gaining a path a game cannot move.
    const files = [
      "packages/engine-core/src/combat-content.ts",
      "packages/engine-core/src/dungeons/content.ts",
      "packages/engine-core/src/pcg/boot.ts",
      "packages/engine-core/src/procgen/biome-registry.ts",
      "packages/engine-core/src/procgen/wildlife-creatures.ts",
      "packages/engine-core/src/procgen/wildlife-table.ts",
      "packages/engine-core/src/procgen/world-populator.ts",
      "packages/engine-core/src/quests/content.ts",
      "packages/engine-core/src/rules/boot.ts",
      "packages/engine-core/src/scale.ts",
      "packages/engine-core/src/scene-spawn.ts",
      "packages/engine-core/src/server-settings.ts",
      "packages/engine-core/src/species-roster.ts",
    ];
    const found = new Set<string>();
    for (const rel of files) {
      for (const m of source(rel).matchAll(/export const (DEFAULT_[A-Z_]+)\s*=[^;]*content\//g)) {
        found.add(m[1] as string);
      }
    }
    const covered = new Set([
      "DEFAULT_COMBAT_FILE",
      "DEFAULT_DUNGEON_CONTENT",
      "DEFAULT_PCG_ASSETS",
      "DEFAULT_BIOME_REGISTRY",
      "DEFAULT_NATURAL_WEAPONS",
      "DEFAULT_WILDLIFE_TABLE",
      "DEFAULT_ECOLOGY_PLAN",
      "DEFAULT_QUEST_DIR",
      "DEFAULT_RULES_DIR",
      "DEFAULT_SCALE_FILE",
      "DEFAULT_SCENES_DIR",
      "DEFAULT_PREFABS_DIR",
      "DEFAULT_SERVER_SETTINGS_DIR",
      "DEFAULT_SPECIES_FILE",
    ]);
    const missing = [...found].filter((n) => !covered.has(n));
    assert.deepEqual(missing, [], `these constants are not in the seam table yet: ${missing.join(", ")}`);
  });

  it("resolves the seams whose default is inline in server.ts to the same place", () => {
    const text = source("packages/engine-core/src/server.ts");
    // server.ts built these from REPO_ROOT before ES2; it now reads them
    // from the project, so what is asserted is the resolved value plus the
    // fact that server.ts no longer spells the path out.
    const inline: [SeamKey, string][] = [
      ["vendorsFile", join(REPO_ROOT, "content", "vendors.json")],
      ["structuresFile", join(REPO_ROOT, "content", "structures.json")],
      ["civicRulesFile", join(REPO_ROOT, "content", "rules", "civic.json")],
      ["settlementsDir", join(REPO_ROOT, "content", "settlements")],
      ["lessonsFile", join(REPO_ROOT, "content", "lessons.json")],
      ["modulesSetFile", join(REPO_ROOT, "content", "modules.json")],
      ["modulesDir", join(REPO_ROOT, "modules")],
    ];
    for (const [key, expected] of inline) {
      assert.equal(project.paths[key], expected, key);
    }
    assert.doesNotMatch(text, /path\.join\(REPO_ROOT, "content"/, "server.ts should read content paths from the project");
  });

  it("leaves no MMO_* || DEFAULT_* pair behind, which would ignore a manifest", () => {
    // Each of these resolves the same seam the project already resolved, so a
    // `game.json` that moved it would be read everywhere but here. Three such
    // pairs survived the first pass (questDir, dungeonDir, respawnAnchors).
    const text = source("packages/engine-core/src/server.ts");
    const pairs = [...text.matchAll(/process\.env\.(MMO_[A-Z_]+)\s*(?:\|\||\?\?)\s*(DEFAULT_[A-Z_]+)/g)].map(
      (m) => `${m[1]} || ${m[2]}`,
    );
    assert.deepEqual(pairs, [], `server.ts should read these from the project: ${pairs.join(", ")}`);
  });

  it("agrees with the settlement CLIs' own resolver, which engine-core does not depend on", () => {
    // packages/settlement/src/paths.ts keeps its own copy by design (the
    // packages do not depend on each other), so this reads its text.
    const text = source("packages/settlement/src/paths.ts");
    for (const [key, literal] of [
      ["settlementRulesFile", 'resolve(root, "content", "settlements", "rules.json")'],
      ["characterRulesFile", 'resolve(root, "content", "settlements", "character.json")'],
      ["settlementsDir", 'resolve(content, "settlements")'],
      ["scenesDir", 'resolve(content, "scenes")'],
      ["scaleFile", 'resolve(content, "scale.json")'],
      ["scaleLocalFile", 'resolve(content, "scale.local.json")'],
      ["catalogFile", 'resolve(assets, "catalog.json")'],
    ] as [SeamKey, string][]) {
      assert.ok(text.includes(literal), `${key}: ${literal} is no longer in settlement/src/paths.ts`);
      assert.equal(project.sources[key], "default");
    }
    assert.equal(project.paths.settlementRulesFile, join(REPO_ROOT, "content", "settlements", "rules.json"));
    assert.equal(project.paths.characterRulesFile, join(REPO_ROOT, "content", "settlements", "character.json"));
    assert.equal(project.paths.scaleLocalFile, join(REPO_ROOT, "content", "scale.local.json"));
    assert.equal(project.paths.catalogFile, join(REPO_ROOT, "assets", "catalog.json"));
    assert.equal(
      project.paths.characterCatalogFile,
      join(REPO_ROOT, "assets", "models", "glb", "modular-fantasy-hero", "Rigged", "catalog.json"),
    );
  });

  it("reads every variable the engine documents for a path", () => {
    const text = source("docs/CONFIGURATION.md");
    for (const seam of SEAMS) {
      for (const name of seam.env) {
        assert.ok(text.includes(`\`${name}\``), `${name} (${seam.key}) is not in CONFIGURATION.md`);
      }
    }
  });

  it("puts the checkout where the engine's own constants put it", () => {
    assert.equal(ENGINE_ROOT, REPO_ROOT.replace(/\/$/, ""));
    assert.equal(project.root, ENGINE_ROOT);
    assert.equal(project.contentDir, join(ENGINE_ROOT, "content"));
  });

  it("leaves nothing in the table unchecked", () => {
    const checked = new Set<string>([
      ...Object.keys(CONSTANTS),
      "vendorsFile",
      "structuresFile",
      "civicRulesFile",
      "settlementsDir",
      "lessonsFile",
      "modulesSetFile",
      "modulesDir",
      "settlementRulesFile",
      "characterRulesFile",
      "characterCreationFile",
      "scaleLocalFile",
      "catalogFile",
      "characterCatalogFile",
      "speciesDir",
      "synthesisFile",
      "animationClipsFile",
      "graphFile",
      "creditsFile",
      "worldSpecFile",
      "dataDir",
    ]);
    assert.deepEqual([...SEAM_KEYS].filter((k) => !checked.has(k)), []);
  });

  it("resolves the remaining seams where the repo actually keeps them", () => {
    assert.equal(project.paths.speciesDir, join(REPO_ROOT, "content", "species"));
    assert.equal(project.paths.characterCreationFile, join(REPO_ROOT, "content", "character-creation.json"));
    assert.equal(project.paths.synthesisFile, join(REPO_ROOT, "content", "synthesis", "fantasy-kingdom.local.json"));
    assert.equal(project.paths.animationClipsFile, join(REPO_ROOT, "content", "animation", "clips.json"));
    assert.equal(project.paths.graphFile, join(REPO_ROOT, "content", "graph", "ecs-graph.json"));
    assert.equal(project.paths.creditsFile, join(REPO_ROOT, "content", "credits.json"));
    assert.equal(project.paths.worldSpecFile, join(REPO_ROOT, "packages", "engine-core", "worlds", "default.world.json"));
    // dataDir has always been relative to where the process was started.
    assert.equal(openGameProject({ env: {}, cwd: "/srv/run", exists: () => false }).paths.dataDir, join("/srv", "run", "data"));
  });
});
