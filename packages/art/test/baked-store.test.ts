import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BAKED_STORE_SCHEMA_VERSION,
  BakedStoreValidationError,
  buildBakedAssetIndex,
  classifyAssetLicence,
  dedupeReport,
  getVariantInfo,
  licenceCoverageReport,
  lookupAssetChunk,
  openBakedAssetStore,
} from "../src/index.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const REAL_ASSETS_DIR = join(REPO_ROOT, "assets");
const REAL_CREDITS_PATH = join(REPO_ROOT, "content", "credits.json");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFixtureFile(root: string, relPath: string, content: string | Uint8Array): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("baked-store schema, roundtrip, and queries", () => {
  it("creates all required SQLite tables and persists roundtrip queries read-only", () => {
    const root = makeTempDir("art-baked-roundtrip-");
    const dbPath = join(root, "out", "store.sqlite");

    const glbA = Buffer.from("GLB-MESH-A-CONTENT-0001");
    const texA = Buffer.from("PNG-TEXTURE-ATLAS-0001");
    const clipBytes = Buffer.from("CLIP-SOA-BYTES-0001");

    writeFixtureFile(root, "models/hero.glb", glbA);
    writeFixtureFile(root, "textures/atlas.png", texA);
    writeFixtureFile(root, "clips/walk.bin", clipBytes);

    const manifest = {
      name: "proto-pack",
      version: "1.2.3",
      models: [{ id: "starter/hero", file: "models/hero.glb", forShape: "1" }],
      textures: [{ id: "starter/atlas", file: "textures/atlas.png", forTerrain: true }],
    };

    const catalog = {
      converterVersion: 4,
      packs: [
        {
          slug: "starter",
          source: "imports/starter",
          models: 1,
          textures: 1,
          license: { author: "Polyfork", name: "CC BY 4.0", page: "https://example.test/starter" },
        },
      ],
      models: [
        {
          id: "starter/hero",
          pack: "starter",
          name: "Hero",
          category: "Characters",
          file: "models/hero.glb",
          license: {
            author: "Polyfork",
            name: "CC BY 4.0",
            page: "https://example.test/hero",
          },
          knobs: [
            { knob: "scale", type: "float", min: 0.5, max: 2.0, def: 1.0 },
            { knob: "hue", type: "float", min: 0, max: 360, def: 120 },
          ],
          knobValues: { hue: 120, scale: 1.0 },
        },
      ],
      diagnostics: [],
    };

    const built = buildBakedAssetIndex({
      assetsRoot: root,
      dbPath,
      target: "shipped-prototype-pack",
      manifest,
      catalog,
      basePacks: ["starter"],
      clips: [
        {
          id: "clip/walk",
          assetId: "starter/hero",
          family: "locomotion",
          verb: "walk",
          frames: 45,
          rate: 30,
          file: "clips/walk.bin",
          licence: { name: "CC BY 4.0", author: "Polyfork" },
        },
      ],
    });

    assert.equal(built.target, "shipped-prototype-pack");
    assert.equal(built.assetCount, 2);
    assert.equal(built.clipCount, 1);
    assert.equal(built.chunkCount, 1);
    assert.equal(built.store.readOnly, true);
    built.store.close();

    // Reopen read-only and verify schema + query roundtrip
    const reopened = openBakedAssetStore(dbPath);
    try {
      assert.equal(reopened.readOnly, true);

      const tables = new Set(
        reopened.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((r) => String(r.name)),
      );
      for (const expected of ["assets", "variants", "chunks", "clips", "knobs", "store_meta"]) {
        assert.ok(tables.has(expected), `missing table ${expected}`);
      }

      const assetCols = reopened.db
        .prepare("PRAGMA table_info(assets)")
        .all()
        .map((r) => String(r.name));
      assert.deepEqual(assetCols, [
        "id",
        "kind",
        "source",
        "hash",
        "chunk_id",
        "byte_offset",
        "byte_length",
        "licence_lane",
        "credit",
      ]);

      const metaRows = Object.fromEntries(
        reopened.db
          .prepare("SELECT key, value FROM store_meta")
          .all()
          .map((r) => [String(r.key), String(r.value)]),
      );
      assert.equal(metaRows.schema_version, String(BAKED_STORE_SCHEMA_VERSION));
      assert.equal(metaRows.target, "shipped-prototype-pack");

      // Read-only enforcement
      assert.throws(() => {
        reopened.db.exec("DELETE FROM assets");
      });

      const heroLookup = lookupAssetChunk(reopened, "starter/hero");
      assert.ok(heroLookup);
      assert.equal(heroLookup.kind, "model");
      assert.equal(heroLookup.chunkId, "base");
      assert.equal(heroLookup.chunkKind, "base");
      assert.equal(heroLookup.byteLength, glbA.byteLength);
      assert.equal(heroLookup.licenceLane, "shipped-prototype-pack");
      assert.match(heroLookup.credit ?? "", /Polyfork/);
      assert.equal(heroLookup.canonicalMeshAssetId, "starter/hero");
      assert.equal(heroLookup.deduplicated, false);

      // Texture lookup works both with "texture" kind and bare id fallback
      const texByKind = lookupAssetChunk(reopened, "starter/atlas", "texture");
      const texByBare = lookupAssetChunk(reopened, "starter/atlas");
      assert.ok(texByKind);
      assert.deepEqual(texByKind, texByBare);
      assert.equal(texByKind.kind, "texture");
      assert.equal(texByKind.byteLength, texA.byteLength);
      assert.notEqual(texByKind.byteOffset, heroLookup.byteOffset);

      const variantInfo = getVariantInfo(reopened, "starter/hero");
      assert.ok(variantInfo);
      assert.equal(variantInfo.canonicalMeshAssetId, "starter/hero");
      assert.equal(variantInfo.isCollapsedVariant, false);
      assert.equal(variantInfo.ownVariants.length, 1);
      assert.equal(variantInfo.ownVariants[0]?.knobJson, '{"hue":120,"scale":1}');
      assert.equal(variantInfo.knobs.length, 2);
      assert.deepEqual(
        variantInfo.knobs.map((k) => k.knob),
        ["hue", "scale"],
      );

      const clipRow = reopened.db.prepare("SELECT * FROM clips WHERE id = ?").get("clip/walk") as Record<
        string,
        unknown
      >;
      assert.equal(clipRow.family, "locomotion");
      assert.equal(clipRow.verb, "walk");
      assert.equal(clipRow.frames, 45);
      assert.equal(clipRow.rate, 30);
      assert.equal(clipRow.licence_lane, "shipped-prototype-pack");

      const cov = licenceCoverageReport(reopened);
      assert.equal(cov.totalAssets, 2);
      assert.equal(cov.totalClips, 1);
      assert.equal(cov.coveredAssets, 2);
      assert.equal(cov.missingOrUnknownAssets, 0);
      assert.equal(cov.unreadyForShippedPack.length, 0);
    } finally {
      reopened.close();
    }
  });

  it("rejects missing store or invalid sqlite database missing required tables", () => {
    const root = makeTempDir("art-baked-open-err-");
    assert.throws(() => openBakedAssetStore(join(root, "does-not-exist.sqlite")), BakedStoreValidationError);

    const bogusDbPath = join(root, "not-a-baked-store.sqlite");
    const rawDb = new DatabaseSync(bogusDbPath);
    rawDb.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
    rawDb.close();
    assert.throws(() => openBakedAssetStore(bogusDbPath), /missing table/i);
  });
});

describe("SHA-256 content-addressed dedupe and variant collapse", () => {
  it("collapses identical files and shared Polyfork variant listings onto one canonical mesh and chunk slot", () => {
    const root = makeTempDir("art-baked-dedupe-");
    const sharedTreeBytes = Buffer.from("GLB-OAK-TREE-SHARED-MESH-PAYLOAD-1234567890");
    const uniqueRockBytes = Buffer.from("GLB-BOULDER-UNIQUE-001");

    // Two distinct files with identical bytes (tree_spring.glb + tree_dup.glb) AND two catalog listings sharing tree_spring.glb
    writeFixtureFile(root, "models/tree_spring.glb", sharedTreeBytes);
    writeFixtureFile(root, "models/tree_dup.glb", sharedTreeBytes);
    writeFixtureFile(root, "models/rock.glb", uniqueRockBytes);

    const manifest = {
      name: "polyfork-synth",
      version: "1.0.0",
      models: [
        { id: "forest/oak_spring", file: "models/tree_spring.glb" },
        { id: "forest/oak_duplicate_file", file: "models/tree_dup.glb" },
        { id: "rock/boulder", file: "models/rock.glb" },
      ],
      textures: [],
    };

    const catalog = {
      converterVersion: 4,
      packs: [
        { slug: "forest", source: "imports/polyfork/forest" },
        { slug: "rock", source: "imports/polyfork/rock" },
      ],
      models: [
        {
          id: "forest/oak_spring",
          pack: "forest",
          file: "models/tree_spring.glb",
          license: { name: "CC BY 4.0", author: "Polyfork" },
          knobValues: { leafHue: 105, snow: 0 },
        },
        {
          id: "forest/oak_autumn",
          pack: "forest",
          file: "models/tree_spring.glb",
          variantOf: "forest/oak_spring",
          license: { name: "CC BY 4.0", author: "Polyfork" },
          knobValues: { snow: 0, leafHue: 28 },
        },
        {
          id: "forest/oak_duplicate_file",
          pack: "forest",
          file: "models/tree_dup.glb",
          license: { name: "CC BY 4.0", author: "Polyfork" },
        },
        {
          id: "rock/boulder",
          pack: "rock",
          file: "models/rock.glb",
          region: "highlands",
          license: { name: "CC BY 4.0", author: "Polyfork" },
        },
      ],
      diagnostics: [],
    };

    const { store, dedupeReport: report } = buildBakedAssetIndex({
      assetsRoot: root,
      dbPath: ":memory:",
      target: "shipped-prototype-pack",
      manifest,
      catalog,
      variants: [{ assetId: "forest/oak_winter", knobs: { snow: 1, leafHue: 0 }, meshAssetId: "forest/oak_autumn" }],
    });

    try {
      assert.equal(report.totalAssets, 4);
      assert.equal(report.uniqueBlobs, 2);
      assert.equal(report.collapsedDuplicates, 2);
      assert.equal(report.duplicateGroups, 1);
      assert.equal(report.rawBytes, sharedTreeBytes.byteLength * 3 + uniqueRockBytes.byteLength);
      assert.equal(report.dedupedBytes, sharedTreeBytes.byteLength + uniqueRockBytes.byteLength);
      assert.equal(report.savedBytes, sharedTreeBytes.byteLength * 2);
      assert.equal(report.chunkCount, 2);

      const oakSpring = lookupAssetChunk(store, "forest/oak_spring")!;
      const oakAutumn = lookupAssetChunk(store, "forest/oak_autumn")!;
      const oakDup = lookupAssetChunk(store, "forest/oak_duplicate_file")!;
      const boulder = lookupAssetChunk(store, "rock/boulder")!;

      // `forest/oak_spring` is explicitly targeted by `oak_autumn.variantOf` so it becomes canonical.
      assert.equal(oakSpring.canonicalMeshAssetId, "forest/oak_spring");
      assert.equal(oakSpring.deduplicated, false);
      assert.equal(oakAutumn.deduplicated, true);
      assert.equal(oakDup.deduplicated, true);
      assert.equal(oakAutumn.hash, oakSpring.hash);
      assert.equal(oakDup.hash, oakSpring.hash);
      assert.equal(oakAutumn.chunkId, "kit:forest");
      assert.equal(oakAutumn.byteOffset, oakSpring.byteOffset);
      assert.equal(oakAutumn.byteLength, sharedTreeBytes.byteLength);
      assert.equal(oakDup.canonicalMeshAssetId, "forest/oak_spring");

      assert.equal(boulder.chunkId, "region:highlands");
      assert.equal(boulder.chunkKind, "region:highlands");

      const canonicalId = oakAutumn.canonicalMeshAssetId;
      const vInfo = getVariantInfo(store, "forest/oak_autumn");
      assert.ok(vInfo);
      assert.equal(vInfo.canonicalMeshAssetId, canonicalId);
      assert.equal(vInfo.isCollapsedVariant, true);
      assert.equal(vInfo.ownVariants[0]?.knobJson, '{"leafHue":28,"snow":0}');
      assert.ok(vInfo.meshVariants.some((v) => v.assetId === "forest/oak_winter" && v.meshAssetId === canonicalId));

      const canonicalInfo = getVariantInfo(store, canonicalId);
      assert.ok(canonicalInfo);
      assert.equal(canonicalInfo.isCollapsedVariant, false);
      assert.equal(canonicalInfo.meshVariants.length, 4);
    } finally {
      store.close();
    }
  });

  it("produces deterministic chunk hashes regardless of knob key order and rejects hash-mismatched variantOf", () => {
    const root = makeTempDir("art-baked-determ-");
    writeFixtureFile(root, "models/a.glb", Buffer.from("MESH-A"));
    writeFixtureFile(root, "models/b.glb", Buffer.from("MESH-B"));

    const buildWithOrder = (knobs: Record<string, unknown>): string => {
      const { store } = buildBakedAssetIndex({
        assetsRoot: root,
        dbPath: ":memory:",
        target: "shipped-prototype-pack",
        manifest: {
          name: "p",
          version: "1.0.0",
          models: [{ id: "kit/a", file: "models/a.glb" }],
          textures: [],
        },
        catalog: {
          packs: [{ slug: "kit", source: "imports/kit" }],
          models: [
            {
              id: "kit/a",
              pack: "kit",
              file: "models/a.glb",
              license: { name: "CC BY 4.0", author: "Tester" },
              knobValues: knobs,
            },
          ],
        },
      });
      const chunkHash = dedupeReport(store).chunks[0]!.hash;
      store.close();
      return chunkHash;
    };

    assert.equal(buildWithOrder({ z: 1, a: 2, nested: { b: true, a: false } }), buildWithOrder({ nested: { a: false, b: true }, a: 2, z: 1 }));

    assert.throws(
      () =>
        buildBakedAssetIndex({
          assetsRoot: root,
          dbPath: ":memory:",
          target: "shipped-prototype-pack",
          manifest: {
            name: "p",
            version: "1.0.0",
            models: [
              { id: "kit/a", file: "models/a.glb" },
              { id: "kit/b", file: "models/b.glb" },
            ],
            textures: [],
          },
          catalog: {
            packs: [{ slug: "kit", source: "imports/kit" }],
            models: [
              { id: "kit/a", pack: "kit", file: "models/a.glb", license: { name: "CC BY 4.0", author: "T" } },
              {
                id: "kit/b",
                pack: "kit",
                file: "models/b.glb",
                variantOf: "kit/a",
                license: { name: "CC BY 4.0", author: "T" },
              },
            ],
          },
        }),
      /hash mismatch/i,
    );
  });
});

describe("manifest validation and path safety gates", () => {
  it("reuses ManifestSchema and checkManifestFiles to reject missing files and path traversal without writing db", () => {
    const root = makeTempDir("art-baked-manifest-");
    const dbPath = join(root, "should-not-exist.sqlite");
    writeFixtureFile(root, "models/present.glb", Buffer.from("OK"));

    assert.throws(
      () =>
        buildBakedAssetIndex({
          assetsRoot: root,
          dbPath,
          target: "shipped-prototype-pack",
          manifest: {
            name: "bad",
            version: "1.0.0",
            models: [{ id: "evil", file: "../evil.glb" }],
            textures: [],
          },
        }),
      z.ZodError,
    );
    assert.equal(existsSync(dbPath), false);

    assert.throws(
      () =>
        buildBakedAssetIndex({
          assetsRoot: root,
          dbPath,
          target: "shipped-prototype-pack",
          manifest: {
            name: "incomplete",
            version: "1.0.0",
            models: [
              { id: "present", file: "models/present.glb" },
              { id: "missing", file: "models/missing.glb" },
            ],
            textures: [],
          },
          packLicences: { incomplete: { name: "CC BY 4.0", author: "A" } },
        }),
      BakedStoreValidationError,
    );
    assert.equal(existsSync(dbPath), false);
  });
});

describe("licence-lane classification and fail-closed validator", () => {
  it("classifies permissive, own-game-only, restricted, and unknown licences accurately", () => {
    const ccBy4 = classifyAssetLicence({ name: "CC BY 4.0", author: "Polyfork", page: "https://polyfork.test/1" });
    assert.equal(ccBy4.licenceLane, "shipped-prototype-pack");
    assert.equal(ccBy4.eligibleForOwnGame, true);
    assert.equal(ccBy4.eligibleForShippedPack, true);
    assert.match(ccBy4.credit ?? "", /Polyfork/);

    const cc0General = classifyAssetLicence({ name: "CC0 1.0", author: "KayKit" });
    assert.equal(cc0General.licenceLane, "shipped-prototype-pack");
    assert.equal(cc0General.eligibleForShippedPack, true);

    const quaterniusRaw = classifyAssetLicence({
      name: "CC0 1.0",
      author: "Quaternius",
      sourcePath: "models/glb/quaternius-animals/Alpaca.glb",
    });
    assert.equal(quaterniusRaw.licenceLane, "own-game");
    assert.equal(quaterniusRaw.eligibleForOwnGame, true);
    assert.equal(quaterniusRaw.eligibleForShippedPack, false);

    const mixamoRaw = classifyAssetLicence({ name: "CC0 1.0", author: "Mixamo", sourcePath: "anims/mixamo/run.fbx" });
    assert.equal(mixamoRaw.licenceLane, "own-game");
    assert.equal(mixamoRaw.eligibleForShippedPack, false);

    const syntyPack = classifyAssetLicence({ packSource: "models/3d/POLYGON_Dungeon_Pack_SourceFiles_v2" });
    assert.equal(syntyPack.licenceLane, "own-game");
    assert.equal(syntyPack.eligibleForOwnGame, true);
    assert.equal(syntyPack.eligibleForShippedPack, false);

    const kevinEula = classifyAssetLicence({
      name: "Standard Unity Asset Store EULA: royalty-free in games, no redistribution",
      author: "Kevin Iglesias",
    });
    assert.equal(kevinEula.licenceLane, "own-game");
    assert.equal(kevinEula.eligibleForOwnGame, true);
    assert.equal(kevinEula.eligibleForShippedPack, false);

    const cmuRetargeted = classifyAssetLicence({
      name: "CMU: free in commercial products, not to be sold as animations",
      author: "CMU Graphics Lab",
    });
    assert.equal(cmuRetargeted.licenceLane, "own-game");
    assert.equal(cmuRetargeted.eligibleForOwnGame, true);
    assert.equal(cmuRetargeted.eligibleForShippedPack, false);

    const polyforkMjs = classifyAssetLicence({ name: "CC BY 4.0", author: "Polyfork", derivedFromMjs: true });
    assert.equal(polyforkMjs.licenceLane, "restricted");
    assert.equal(polyforkMjs.eligibleForOwnGame, false);
    assert.equal(polyforkMjs.eligibleForShippedPack, false);

    const noCreditCcBy = classifyAssetLicence({ name: "CC BY 4.0" });
    assert.equal(noCreditCcBy.eligibleForShippedPack, false);

    const missing = classifyAssetLicence(undefined);
    assert.equal(missing.licenceLane, "unknown");
    assert.equal(missing.eligibleForOwnGame, false);
    assert.equal(missing.eligibleForShippedPack, false);
  });

  it("fails closed on shipped-prototype-pack for missing, unknown, EULA, .mjs, raw CMU, HD, and Quaternius inputs without leaving db on disk", () => {
    const root = makeTempDir("art-baked-lic-reject-");
    writeFixtureFile(root, "models/item.glb", Buffer.from("GLB-ITEM"));

    const rejectingCases: Array<{ label: string; modelCat: Record<string, unknown> }> = [
      { label: "missing licence", modelCat: {} },
      { label: "null licence name", modelCat: { license: { author: "Someone", name: null } } },
      { label: "unknown licence", modelCat: { license: { author: "Someone", name: "Mystery-Custom-License" } } },
      { label: "EULA no redistribution", modelCat: { license: { author: "Vendor", name: "Unity Asset Store EULA: no redistribution" } } },
      { label: "Polyfork .mjs derived", modelCat: { license: { author: "Polyfork", name: "CC BY 4.0" }, derivedFromMjs: true } },
      { label: "raw CMU library", modelCat: { license: { author: "CMU", name: "Raw CMU library" } } },
      { label: "HD edition", modelCat: { license: { author: "Polyfork", name: "HD edition" } } },
      { label: "Quaternius raw", modelCat: { license: { author: "Quaternius", name: "CC0 1.0" } } },
      { label: "CC-BY 4.0 missing credit", modelCat: { license: { name: "CC BY 4.0" } } },
    ];

    for (const tc of rejectingCases) {
      const dbPath = join(root, `reject-${tc.label.replace(/[^a-z0-9]+/gi, "_")}.sqlite`);
      assert.throws(
        () =>
          buildBakedAssetIndex({
            assetsRoot: root,
            dbPath,
            target: "shipped-prototype-pack",
            manifest: {
              name: "test",
              version: "1.0.0",
              models: [{ id: "pack/item", file: "models/item.glb" }],
              textures: [],
            },
            catalog: {
              packs: [{ slug: "pack", source: "imports/pack" }],
              models: [{ id: "pack/item", pack: "pack", file: "models/item.glb", ...tc.modelCat }],
            },
          }),
        (err) => err instanceof BakedStoreValidationError && err.rejections.length === 1,
        `expected fail-closed rejection for: ${tc.label}`,
      );
      assert.equal(existsSync(dbPath), false, `failed bake must not write ${dbPath}`);
    }
  });

  it("allows own-game licences under own-game target while enforcing clip licence gates across both targets", () => {
    const root = makeTempDir("art-baked-clips-");
    writeFixtureFile(root, "models/knight.glb", Buffer.from("GLB-KNIGHT"));
    writeFixtureFile(root, "anims/ual1.glb", Buffer.from("ANIM-UAL1"));
    writeFixtureFile(root, "anims/ki.glb", Buffer.from("ANIM-KI"));

    const animManifest = {
      version: 2 as const,
      sources: [
        {
          id: "ki-melee",
          title: "Human Melee",
          author: "Kevin Iglesias",
          license: "Standard Unity Asset Store EULA: royalty-free in games, no redistribution",
          url: "https://kevdev.itch.io/human-melee",
          file: "anims/ki.glb",
        },
        {
          id: "mesh2motion",
          title: "Mesh2Motion",
          author: "Mesh2Motion contributors",
          license: "CC0-1.0",
          url: "https://mesh2motion.org",
          file: "anims/ual1.glb",
        },
      ],
      clips: [
        { name: "Sword_A", source: "ki-melee", duration: 1.0, loop: false, travel: [0, 0] as [number, number] },
        { name: "Walk_Loop", source: "mesh2motion", duration: 1.2, loop: true, travel: [0, 0] as [number, number] },
      ],
    };

    const ownGame = buildBakedAssetIndex({
      assetsRoot: root,
      dbPath: ":memory:",
      target: "own-game",
      manifest: {
        name: "own",
        version: "1.0.0",
        models: [{ id: "dungeon-pack/knight", file: "models/knight.glb" }],
        textures: [],
      },
      catalog: {
        packs: [{ slug: "dungeon-pack", source: "models/3d/POLYGON_Dungeon_Pack_SourceFiles_v2" }],
        models: [{ id: "dungeon-pack/knight", pack: "dungeon-pack", file: "models/knight.glb" }],
      },
      animationsManifest: animManifest,
    });
    try {
      const cov = ownGame.licenceCoverageReport;
      assert.equal(cov.totalAssets, 1);
      assert.equal(cov.totalClips, 2);
      assert.equal(cov.ownGameOnlyAssets, 1);
      assert.equal(cov.clipsByLane["own-game"], 1);
      assert.equal(cov.clipsByLane["shipped-prototype-pack"], 1);
    } finally {
      ownGame.store.close();
    }

    // Same clip set must fail closed when targeting shipped-prototype-pack due to Kevin Iglesias clip
    assert.throws(
      () =>
        buildBakedAssetIndex({
          assetsRoot: root,
          dbPath: ":memory:",
          target: "shipped-prototype-pack",
          manifest: {
            name: "ship",
            version: "1.0.0",
            models: [{ id: "open/knight", file: "models/knight.glb" }],
            textures: [],
          },
          catalog: {
            packs: [{ slug: "open", source: "imports/open" }],
            models: [
              {
                id: "open/knight",
                pack: "open",
                file: "models/knight.glb",
                license: { name: "CC BY 4.0", author: "OpenArtist" },
              },
            ],
          },
          animationsManifest: animManifest,
        }),
      (err) => err instanceof BakedStoreValidationError && err.rejections.some((r) => r.id === "Sword_A"),
    );
  });
});

describe("real assets/catalog.json + assets/manifest.json integration", () => {
  const hasRealAssets =
    existsSync(join(REAL_ASSETS_DIR, "catalog.json")) &&
    existsSync(join(REAL_ASSETS_DIR, "manifest.json"));

  it("indexes real assets/ for own-game with dedupe + credit enrichment, and fails closed for shipped-prototype-pack", (t) => {
    if (!hasRealAssets) {
      t.skip("gitignored assets/catalog.json and assets/manifest.json not present in this checkout");
      return;
    }

    const outDir = makeTempDir("art-baked-real-");
    const dbPath = join(outDir, "real-assets.sqlite");

    // 1. Targeting shipped-prototype-pack on real assets/ MUST fail closed
    assert.throws(
      () =>
        buildBakedAssetIndex({
          assetsRoot: REAL_ASSETS_DIR,
          dbPath: join(outDir, "shipped-fail.sqlite"),
          target: "shipped-prototype-pack",
          creditsPath: existsSync(REAL_CREDITS_PATH) ? REAL_CREDITS_PATH : undefined,
        }),
      (err) => err instanceof BakedStoreValidationError && err.rejections.length > 4000,
    );
    assert.equal(existsSync(join(outDir, "shipped-fail.sqlite")), false);

    // 2. Targeting own-game indexes all 4,577 models + 163 textures and passes licence coverage
    const result = buildBakedAssetIndex({
      assetsRoot: REAL_ASSETS_DIR,
      dbPath,
      target: "own-game",
      creditsPath: existsSync(REAL_CREDITS_PATH) ? REAL_CREDITS_PATH : undefined,
    });

    try {
      const manifestJson = JSON.parse(readFileSync(join(REAL_ASSETS_DIR, "manifest.json"), "utf8")) as {
        models: unknown[];
        textures: unknown[];
      };
      const expectedTotal = manifestJson.models.length + manifestJson.textures.length;

      assert.equal(result.assetCount, expectedTotal);
      assert.equal(result.chunkCount, 12);

      const dedupe = result.dedupeReport;
      assert.equal(dedupe.totalAssets, expectedTotal);
      assert.ok(dedupe.duplicateGroups >= 9);
      assert.ok(dedupe.collapsedDuplicates >= 9);
      assert.ok(dedupe.savedBytes > 0);
      assert.ok(dedupe.dedupedBytes < dedupe.rawBytes);

      const cov = result.licenceCoverageReport;
      assert.equal(cov.totalAssets, expectedTotal);
      assert.equal(cov.missingOrUnknownAssets, 0);
      assert.equal(cov.restrictedAssets, 0);
      assert.equal(cov.coverageRatio, 1);
      assert.ok(cov.shippedPackEligibleAssets > 0);
      assert.ok(cov.ownGameOnlyAssets > 0);

      // Verify overlapping model + texture id (`fantasy-rivals/Mystic_Arms`) both resolve cleanly
      const modelLookup = lookupAssetChunk(result.store, "fantasy-rivals/Mystic_Arms", "model");
      const texLookup = lookupAssetChunk(result.store, "fantasy-rivals/Mystic_Arms", "texture");
      assert.ok(modelLookup);
      assert.ok(texLookup);
      assert.equal(modelLookup.kind, "model");
      assert.equal(texLookup.kind, "texture");
      assert.equal(modelLookup.chunkId, "kit:fantasy-rivals");
      assert.equal(texLookup.chunkId, "kit:fantasy-rivals");

      // Verify a real duplicate pair collapsed via SHA-256
      const appleA = lookupAssetChunk(result.store, "farm-produce/Apple_5hRReRDr0v4");
      const appleB = lookupAssetChunk(result.store, "farm-produce/Apple_9cFoY7E-8mu");
      assert.ok(appleA);
      assert.ok(appleB);
      assert.equal(appleA.hash, appleB.hash);
      assert.equal(appleA.byteOffset, appleB.byteOffset);
      assert.equal(appleA.canonicalMeshAssetId, appleB.canonicalMeshAssetId);
      assert.equal(appleA.licenceLane, "shipped-prototype-pack");
      assert.match(appleA.credit ?? "", /Poly by Google/);

      const appleVar = getVariantInfo(result.store, "farm-produce/Apple_9cFoY7E-8mu");
      assert.ok(appleVar);
      assert.equal(appleVar.isCollapsedVariant, true);
      assert.equal(appleVar.canonicalMeshAssetId, appleA.canonicalMeshAssetId);

      // Verify Quaternius animals are classified own-game only per §4 ("no Quaternius/Mixamo raw files")
      const alpaca = lookupAssetChunk(result.store, "quaternius-animals/Alpaca");
      assert.ok(alpaca);
      assert.equal(alpaca.licenceLane, "own-game");
    } finally {
      result.store.close();
    }
  });
});
