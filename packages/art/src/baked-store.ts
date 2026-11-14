/**
 * Baked Asset Store — B0 SQLite index, SHA-256 content-addressed deduplication,
 * variant collapse, and fail-closed licence-lane validation.
 *
 * Implements Phase B0 of `patches/BAKED-ASSET-STORE-SPEC.md`:
 * - SQLite schema (`assets`, `variants`, `chunks`, `clips`, `knobs`, plus `store_meta`)
 *   via Node's built-in `node:sqlite` (`DatabaseSync`), kept separate from world-state DBs.
 * - Manifest & catalog ingestion reusing `parseManifestJSON` and `checkManifestFiles`
 *   from `./manifest.js`, plus optional `parseCredits` from `./credits.js`.
 * - SHA-256 content-addressed chunk allocation and variant collapse (identical file
 *   bytes and/or Polyfork-style variant listings collapse onto a single canonical mesh
 *   asset and single chunk byte slot).
 * - Fail-closed licence-lane classifier & validator distinguishing `"own-game"` from
 *   `"shipped-prototype-pack"`, rejecting missing, unknown, or restricted licences.
 * - Read-only query helpers: `lookupAssetChunk`, `getVariantInfo`, `dedupeReport`,
 *   and `licenceCoverageReport`.
 *
 * Node-only module (uses `node:sqlite`, `node:crypto`, `node:fs`, `node:path`).
 * Do NOT re-export from `browser.ts`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type { AnimationManifest } from "./character/animations.js";
import { parseCredits, type CreditEntry } from "./credits.js";
import { checkManifestFiles, parseManifestJSON, type AssetManifest } from "./manifest.js";
import { errMessage } from "./util.js";

export const BAKED_STORE_SCHEMA_VERSION = 1;

export type BakeTarget = "own-game" | "shipped-prototype-pack";
export type AssetKind = "model" | "texture" | "clip" | "vfx" | "material";
export type LicenceLane = "shipped-prototype-pack" | "own-game" | "restricted" | "unknown";
export type ChunkKind = "base" | `kit:${string}` | `region:${string}`;

/** Licence metadata associated with a pack, asset, or clip input. */
export interface AssetLicenceInput {
  name?: string | null;
  author?: string | null;
  page?: string | null;
  licenceLane?: LicenceLane | string | null;
  credit?: string | null;
  /** True when derived from Polyfork `.mjs` generator source (forbidden in shipped pack). */
  derivedFromMjs?: boolean;
  /** True when asset is a raw restricted source file (raw CMU, HD edition, raw Quaternius/Mixamo). */
  rawSourceRestricted?: boolean;
  sourcePath?: string;
  packSlug?: string;
  packSource?: string;
}

export interface LicenceClassification {
  licenceLane: LicenceLane;
  sourceLicence: string | null;
  credit: string | null;
  eligibleForOwnGame: boolean;
  eligibleForShippedPack: boolean;
  reason: string;
}

export interface LicenceRejection {
  id: string;
  kind: AssetKind;
  licenceLane: LicenceLane;
  sourceLicence: string | null;
  reason: string;
}

export class BakedStoreValidationError extends Error {
  readonly issues: readonly string[];
  readonly rejections: readonly LicenceRejection[];

  constructor(message: string, issues: readonly string[] = [], rejections: readonly LicenceRejection[] = []) {
    super(message);
    this.name = "BakedStoreValidationError";
    this.issues = issues;
    this.rejections = rejections;
  }
}

export interface BakedKnobInput {
  assetId: string;
  knob: string;
  type: string;
  min?: number | null;
  max?: number | null;
  def?: number | null;
}

export interface BakedVariantInput {
  assetId: string;
  knobs: Record<string, unknown>;
  meshAssetId: string;
}

export interface BakedClipInput {
  id: string;
  assetId: string;
  family: string;
  verb: string;
  frames: number;
  rate: number;
  /** Path relative to `assetsRoot` (POSIX). Required unless `hash` is supplied directly. */
  file?: string;
  hash?: string;
  licence?: AssetLicenceInput | string | null;
  author?: string | null;
  credit?: string | null;
  derivedFromMjs?: boolean;
  rawSourceRestricted?: boolean;
}

export interface BuildBakedAssetIndexOptions {
  /** Root directory containing `manifest.json` (and optionally `catalog.json`) and referenced files. */
  assetsRoot: string;
  /** SQLite file path to write, or `":memory:"` for an in-memory store. */
  dbPath: string;
  /** Bake gate target. Defaults to `"own-game"`. */
  target?: BakeTarget;
  /** Optional in-memory manifest JSON (skips reading `<assetsRoot>/manifest.json`). */
  manifest?: unknown;
  /** Optional path to manifest JSON (defaults to `<assetsRoot>/manifest.json`). */
  manifestPath?: string;
  /** Optional in-memory catalog JSON (skips reading `<assetsRoot>/catalog.json`). */
  catalog?: unknown;
  /** Optional path to catalog JSON (defaults to `<assetsRoot>/catalog.json` if present). */
  catalogPath?: string;
  /** Optional in-memory credits JSON (validated with `parseCredits`). */
  credits?: unknown;
  /** Optional path to credits JSON (used when `credits` is omitted). */
  creditsPath?: string;
  /** Optional in-memory animation manifest (`animations.json`). */
  animationsManifest?: AnimationManifest;
  /** Optional path to `animations.json`. */
  animationsManifestPath?: string;
  /** Optional root directory for resolving `animationsManifest.sources[].file` (defaults to dirname of `animationsManifestPath` or `assetsRoot`). */
  animationsRoot?: string;
  /** Explicit clip records to validate and store in `clips`. */
  clips?: readonly BakedClipInput[];
  /** Explicit knob schema definitions to store in `knobs`. */
  knobs?: readonly BakedKnobInput[];
  /** Explicit variant rows to store in `variants`. */
  variants?: readonly BakedVariantInput[];
  /** Pack slugs whose assets belong in the `'base'` chunk instead of `'kit:<slug>'`. */
  basePacks?: ReadonlySet<string> | readonly string[];
  /** Optional custom chunk assignment (`'base'`, `'kit:<id>'`, or `'region:<id>'`). */
  chunkForAsset?: (asset: {
    id: string;
    kind: AssetKind;
    pack?: string;
    category?: string;
    file: string;
  }) => string;
  /** Per-pack fallback licence metadata (used when catalog/model entries lack a `license`). */
  packLicences?: Readonly<Record<string, AssetLicenceInput | string>>;
  /** Per-asset licence override keyed by asset id (or texture id). */
  assetLicences?: Readonly<Record<string, AssetLicenceInput | string>>;
  /** Allow replacing an existing file at `dbPath`. Defaults to `true`. */
  overwrite?: boolean;
}

export interface AssetChunkLookup {
  assetId: string;
  kind: AssetKind;
  source: string;
  hash: string;
  chunkId: string;
  chunkKind: string;
  chunkHash: string;
  chunkBytes: number;
  byteOffset: number;
  byteLength: number;
  licenceLane: LicenceLane;
  credit: string | null;
  canonicalMeshAssetId: string;
  deduplicated: boolean;
}

export interface VariantEntry {
  assetId: string;
  knobJson: string;
  knobs: Record<string, unknown>;
  meshAssetId: string;
}

export interface KnobDefinition {
  assetId: string;
  knob: string;
  type: string;
  min: number | null;
  max: number | null;
  def: number | null;
}

export interface VariantInfo {
  assetId: string;
  canonicalMeshAssetId: string;
  isCollapsedVariant: boolean;
  ownVariants: VariantEntry[];
  meshVariants: VariantEntry[];
  knobs: KnobDefinition[];
}

export interface DedupeGroupSummary {
  hash: string;
  canonicalMeshAssetId: string;
  byteLength: number;
  assetIds: string[];
  duplicateCount: number;
  bytesSaved: number;
}

export interface ChunkSummary {
  id: string;
  kind: string;
  hash: string;
  bytes: number;
  assetCount: number;
}

export interface DedupeReport {
  totalAssets: number;
  uniqueBlobs: number;
  collapsedDuplicates: number;
  variantRows: number;
  duplicateGroups: number;
  rawBytes: number;
  dedupedBytes: number;
  savedBytes: number;
  dedupeRatio: number;
  chunkCount: number;
  chunks: ChunkSummary[];
  topDuplicates: DedupeGroupSummary[];
}

export interface UnreadyAssetSummary {
  id: string;
  kind: string;
  source: string;
  licenceLane: string;
  credit: string | null;
}

export interface LicenceCoverageReport {
  totalAssets: number;
  totalClips: number;
  coveredAssets: number;
  coveredClips: number;
  missingOrUnknownAssets: number;
  missingOrUnknownClips: number;
  restrictedAssets: number;
  restrictedClips: number;
  shippedPackEligibleAssets: number;
  ownGameOnlyAssets: number;
  assetsWithCredit: number;
  coverageRatio: number;
  byLane: Record<string, number>;
  clipsByLane: Record<string, number>;
  unreadyForShippedPack: UnreadyAssetSummary[];
}

export interface BuildBakedAssetIndexResult {
  store: BakedAssetStore;
  target: BakeTarget;
  assetCount: number;
  clipCount: number;
  chunkCount: number;
  dedupeReport: DedupeReport;
  licenceCoverageReport: LicenceCoverageReport;
}

export interface OpenBakedAssetStoreOptions {
  /** Open SQLite in read-only mode. Defaults to `true` for file paths, `false` for `":memory:"`. */
  readOnly?: boolean;
}

const REQUIRED_TABLES = ["assets", "variants", "chunks", "clips", "knobs"] as const;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  kind TEXT NOT NULL CHECK (kind = 'base' OR kind LIKE 'kit:%' OR kind LIKE 'region:%')
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  hash TEXT NOT NULL,
  chunk_id TEXT NOT NULL REFERENCES chunks(id),
  byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  licence_lane TEXT NOT NULL CHECK (length(licence_lane) > 0),
  credit TEXT
);

CREATE TABLE IF NOT EXISTS variants (
  asset_id TEXT NOT NULL,
  knob_json TEXT NOT NULL,
  mesh_asset_id TEXT NOT NULL REFERENCES assets(id),
  PRIMARY KEY (asset_id, knob_json)
);

CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  family TEXT NOT NULL,
  verb TEXT NOT NULL,
  licence_lane TEXT NOT NULL CHECK (length(licence_lane) > 0),
  hash TEXT NOT NULL,
  frames INTEGER NOT NULL CHECK (frames >= 0),
  rate REAL NOT NULL CHECK (rate > 0)
);

CREATE TABLE IF NOT EXISTS knobs (
  asset_id TEXT NOT NULL,
  knob TEXT NOT NULL,
  type TEXT NOT NULL,
  min REAL,
  max REAL,
  def REAL,
  PRIMARY KEY (asset_id, knob)
);

CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(hash);
CREATE INDEX IF NOT EXISTS idx_assets_chunk ON assets(chunk_id);
CREATE INDEX IF NOT EXISTS idx_assets_licence ON assets(licence_lane);
CREATE INDEX IF NOT EXISTS idx_variants_mesh ON variants(mesh_asset_id);
CREATE INDEX IF NOT EXISTS idx_clips_family_verb ON clips(family, verb);
`;

const LicenseObjectSchema = z.object({
  author: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  page: z.string().nullable().optional(),
});

const CatalogKnobSchema = z.object({
  knob: z.string().min(1),
  type: z.string().min(1).default("float"),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  def: z.number().nullable().optional(),
});

const CatalogPackSchema = z.object({
  slug: z.string().min(1),
  source: z.string().min(1),
  models: z.number().int().nonnegative().optional(),
  textures: z.number().int().nonnegative().optional(),
  imported: z.boolean().optional(),
  license: z.union([LicenseObjectSchema, z.string()]).nullable().optional(),
  licence: z.string().nullable().optional(),
  licenceLane: z.string().nullable().optional(),
  credit: z.string().nullable().optional(),
});

const CatalogModelSchema = z.object({
  id: z.string().min(1),
  pack: z.string().min(1),
  name: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  file: z.string().min(1),
  animations: z.number().int().nonnegative().optional(),
  license: z.union([LicenseObjectSchema, z.string()]).nullable().optional(),
  licence: z.string().nullable().optional(),
  licenceLane: z.string().nullable().optional(),
  licence_lane: z.string().nullable().optional(),
  credit: z.string().nullable().optional(),
  derivedFromMjs: z.boolean().optional(),
  rawSourceRestricted: z.boolean().optional(),
  variantOf: z.string().min(1).optional(),
  meshAssetId: z.string().min(1).optional(),
  knobValues: z.record(z.string(), z.unknown()).optional(),
  knobs: z.union([z.array(CatalogKnobSchema), z.record(z.string(), z.unknown())]).optional(),
  chunkId: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
});

const CatalogSchema = z.object({
  converterVersion: z.number().int().nonnegative().optional(),
  packs: z.array(CatalogPackSchema).default([]),
  models: z.array(CatalogModelSchema).default([]),
  diagnostics: z.array(z.string()).default([]),
});

type ParsedCatalog = z.infer<typeof CatalogSchema>;
type ParsedCatalogPack = z.infer<typeof CatalogPackSchema>;
type ParsedCatalogModel = z.infer<typeof CatalogModelSchema>;

function compareCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Canonical JSON serialization with sorted keys so identical knob sets produce identical PKs. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort(compareCodepoint);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSafeRelativePosixPath(relPath: string, label: string): void {
  if (
    relPath.length === 0 ||
    relPath.startsWith("/") ||
    /^[A-Za-z]:/.test(relPath) ||
    relPath.includes("\\") ||
    relPath.split("/").includes("..")
  ) {
    throw new BakedStoreValidationError(`${label}: unsafe relative path "${relPath}"`, [
      `${label}: unsafe relative path "${relPath}"`,
    ]);
  }
}

function resolveContainedFile(rootDir: string, relPath: string, label: string): string {
  assertSafeRelativePosixPath(relPath, label);
  const resolvedRoot = resolve(rootDir);
  const resolvedFile = resolve(resolvedRoot, relPath);
  const rel = relative(resolvedRoot, resolvedFile);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new BakedStoreValidationError(`${label}: path "${relPath}" escapes root "${rootDir}"`, [
      `${label}: path "${relPath}" escapes root "${rootDir}"`,
    ]);
  }
  return resolvedFile;
}

function validateChunkId(chunkId: string): ChunkKind {
  if (chunkId === "base") return "base";
  if (chunkId.startsWith("kit:") && chunkId.length > 4) return chunkId as `kit:${string}`;
  if (chunkId.startsWith("region:") && chunkId.length > 7) return chunkId as `region:${string}`;
  throw new BakedStoreValidationError(
    `Invalid chunk id "${chunkId}": expected 'base', 'kit:<kit-id>', or 'region:<region-id>'`,
    [`Invalid chunk id "${chunkId}"`],
  );
}

function normalizeLicenceInput(
  raw: AssetLicenceInput | string | null | undefined,
): AssetLicenceInput {
  if (!raw) return {};
  if (typeof raw === "string") return { name: raw };
  return raw;
}

function formatCreditString(
  author: string | null | undefined,
  licenceName: string | null | undefined,
  page: string | null | undefined,
  creditIndex?: ReadonlyMap<string, CreditEntry>,
): string | null {
  const cleanAuthor = author?.trim() || null;
  const cleanPage = page?.trim() || null;
  const cleanName = licenceName?.trim() || null;

  if (cleanAuthor && creditIndex) {
    const entry = creditIndex.get(cleanAuthor.toLowerCase());
    if (entry) {
      return cleanPage ? `${entry.text} (${cleanPage})` : entry.text;
    }
  }
  if (!cleanAuthor) return null;
  const parts = [cleanAuthor];
  if (cleanName) parts.push(cleanName);
  const head = parts.join(" — ");
  return cleanPage ? `${head} (${cleanPage})` : head;
}

/**
 * Classify an asset's source licence metadata into a `LicenceLane` and check
 * whether it may ship in `"own-game"` and/or `"shipped-prototype-pack"`.
 *
 * Fail-closed: missing, null, unrecognized, `.mjs`-derived, raw CMU/Quaternius/Mixamo,
 * HD edition, and non-redistributable EULA assets never enter `"shipped-prototype-pack"`.
 */
export function classifyAssetLicence(
  rawInput: AssetLicenceInput | string | null | undefined,
  creditIndex?: ReadonlyMap<string, CreditEntry>,
): LicenceClassification {
  const input = normalizeLicenceInput(rawInput);
  const sourceLicence = input.name?.trim() || null;
  const author = input.author?.trim() || null;
  const sourcePath = input.sourcePath?.trim() || "";
  const packSlug = input.packSlug?.trim() || "";
  const packSource = input.packSource?.trim() || "";
  const combinedSource = `${sourcePath} ${packSlug} ${packSource} ${author ?? ""}`;

  let credit = input.credit?.trim() || formatCreditString(author, sourceLicence, input.page, creditIndex);

  if (
    input.derivedFromMjs === true ||
    /\.mjs$/i.test(sourcePath) ||
    (sourceLicence && /polyfork\s*\.?mjs|\.mjs\s+source/i.test(sourceLicence))
  ) {
    return {
      licenceLane: "restricted",
      sourceLicence,
      credit,
      eligibleForOwnGame: false,
      eligibleForShippedPack: false,
      reason: "derived from Polyfork .mjs source (forbidden for bake/redistribution)",
    };
  }

  if (
    input.rawSourceRestricted === true ||
    (sourceLicence && /\b(raw\s+cmu|hd[- ]editions?)\b/i.test(sourceLicence)) ||
    /\bhd[- ]editions?\b/i.test(sourcePath)
  ) {
    return {
      licenceLane: "restricted",
      sourceLicence,
      credit,
      eligibleForOwnGame: false,
      eligibleForShippedPack: false,
      reason: "raw CMU library or HD edition asset is restricted",
    };
  }

  // Synty POLYGON local studio source packs in assets/catalog.json carry no per-model
  // license object because convert-packs converts local purchased FBX folders.
  if (!sourceLicence && /^models\/3d\/POLYGON_/i.test(packSource)) {
    return {
      licenceLane: "own-game",
      sourceLicence: "Synty POLYGON EULA",
      credit: credit ?? "Synty Studios POLYGON EULA (own game only, no redistribution)",
      eligibleForOwnGame: true,
      eligibleForShippedPack: false,
      reason: "Synty POLYGON studio pack (own game only; not redistributable)",
    };
  }

  if (!sourceLicence) {
    if (input.licenceLane === "own-game") {
      return {
        licenceLane: "own-game",
        sourceLicence: "own-game",
        credit,
        eligibleForOwnGame: true,
        eligibleForShippedPack: false,
        reason: "explicit own-game lane override (not cleared for shipped pack)",
      };
    }
    return {
      licenceLane: "unknown",
      sourceLicence: null,
      credit,
      eligibleForOwnGame: false,
      eligibleForShippedPack: false,
      reason: "missing licence metadata",
    };
  }

  if (
    /\b(cc[- ]?by[- ]?nc|cc[- ]?by[- ]?nd|non[- ]?commercial|all\s+rights\s+reserved|forbidden|restricted)\b/i.test(
      sourceLicence,
    )
  ) {
    return {
      licenceLane: "restricted",
      sourceLicence,
      credit,
      eligibleForOwnGame: false,
      eligibleForShippedPack: false,
      reason: `restricted licence "${sourceLicence}"`,
    };
  }

  if (
    /\b(no\s+redistribution|not\s+to\s+be\s+sold|unity\s+asset\s+store\s+eula|synty|polygon\s+eula|proprietary|own[- ]game|polyfork[- ]glb)\b/i.test(
      sourceLicence,
    )
  ) {
    return {
      licenceLane: "own-game",
      sourceLicence,
      credit,
      eligibleForOwnGame: true,
      eligibleForShippedPack: false,
      reason: `own-game-only licence "${sourceLicence}" (redistribution forbidden)`,
    };
  }

  // Retargeted CMU mocap clips (must have attribution; not redistributable as raw/pack animations).
  if (/\bcmu\b/i.test(sourceLicence)) {
    if (/\braw\b/i.test(sourceLicence)) {
      return {
        licenceLane: "restricted",
        sourceLicence,
        credit,
        eligibleForOwnGame: false,
        eligibleForShippedPack: false,
        reason: "raw CMU library is restricted",
      };
    }
    return {
      licenceLane: "own-game",
      sourceLicence,
      credit: credit ?? "CMU Graphics Lab (mocap.cs.cmu.edu, NSF EIA-0196217)",
      eligibleForOwnGame: true,
      eligibleForShippedPack: false,
      reason: "CMU retargeted clip (own game only)",
    };
  }

  // CC0 / Public Domain: allowed in shipped pack UNLESS Quaternius/Mixamo raw files (§4).
  if (/^cc0(\b|[- ]\d)/i.test(sourceLicence) || /\bkaykit\s+cc0\b/i.test(sourceLicence)) {
    if (/\b(quaternius|mixamo)\b/i.test(combinedSource)) {
      return {
        licenceLane: "own-game",
        sourceLicence,
        credit,
        eligibleForOwnGame: true,
        eligibleForShippedPack: false,
        reason: "Quaternius/Mixamo raw files are excluded from shipped prototype pack",
      };
    }
    return {
      licenceLane: "shipped-prototype-pack",
      sourceLicence,
      credit,
      eligibleForOwnGame: true,
      eligibleForShippedPack: true,
      reason: `permissive public-domain licence "${sourceLicence}"`,
    };
  }

  // CC-BY 4.0 and CC-BY 3.0 (e.g., Polyfork GLBs and Poly Pizza credits.json entries).
  if (/^cc[- ]?by[- ]?(4\.0|3\.0)\b/i.test(sourceLicence)) {
    if (/\b(quaternius|mixamo)\b/i.test(combinedSource)) {
      return {
        licenceLane: "own-game",
        sourceLicence,
        credit,
        eligibleForOwnGame: true,
        eligibleForShippedPack: false,
        reason: "Quaternius/Mixamo raw files are excluded from shipped prototype pack",
      };
    }
    if (!credit) {
      return {
        licenceLane: "own-game",
        sourceLicence,
        credit: null,
        eligibleForOwnGame: true,
        eligibleForShippedPack: false,
        reason: `${sourceLicence} requires author/credit attribution for CREDITS.md`,
      };
    }
    return {
      licenceLane: "shipped-prototype-pack",
      sourceLicence,
      credit,
      eligibleForOwnGame: true,
      eligibleForShippedPack: true,
      reason: `attribution licence "${sourceLicence}" with credit`,
    };
  }

  return {
    licenceLane: "unknown",
    sourceLicence,
    credit,
    eligibleForOwnGame: false,
    eligibleForShippedPack: false,
    reason: `unrecognized licence "${sourceLicence}"`,
  };
}

/**
 * Validate a list of classified records against the requested `BakeTarget`.
 * Throws `BakedStoreValidationError` (fail-closed) on any non-compliant item.
 */
export function validateBakeLicences(
  entries: ReadonlyArray<{ id: string; kind: AssetKind; classification: LicenceClassification }>,
  target: BakeTarget,
): void {
  const rejections: LicenceRejection[] = [];
  for (const entry of entries) {
    const allowed =
      target === "shipped-prototype-pack"
        ? entry.classification.eligibleForShippedPack
        : entry.classification.eligibleForOwnGame;
    if (!allowed) {
      rejections.push({
        id: entry.id,
        kind: entry.kind,
        licenceLane: entry.classification.licenceLane,
        sourceLicence: entry.classification.sourceLicence,
        reason: entry.classification.reason,
      });
    }
  }
  if (rejections.length > 0) {
    const preview = rejections
      .slice(0, 8)
      .map((r) => `${r.kind} "${r.id}" [${r.licenceLane}]: ${r.reason}`)
      .join("; ");
    const extra = rejections.length > 8 ? ` (+${rejections.length - 8} more)` : "";
    throw new BakedStoreValidationError(
      `Bake licence gate failed for target "${target}" (${rejections.length} rejected): ${preview}${extra}`,
      rejections.map((r) => `${r.kind} "${r.id}": ${r.reason}`),
      rejections,
    );
  }
}

function buildCreditIndex(creditsRaw: unknown): Map<string, CreditEntry> {
  const index = new Map<string, CreditEntry>();
  if (creditsRaw === undefined) return index;
  const parsed = parseCredits(creditsRaw);
  for (const entry of parsed.thirdPartyArt) {
    index.set(entry.author.toLowerCase(), entry);
  }
  return index;
}

function loadJsonFile(filePath: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (err) {
    throw new BakedStoreValidationError(`Failed to read ${label} "${filePath}": ${errMessage(err)}`, [
      `${label}: ${errMessage(err)}`,
    ]);
  }
}

interface ResolvedAssetInput {
  id: string;
  kind: AssetKind;
  file: string;
  pack?: string;
  category?: string;
  classification: LicenceClassification;
  chunkId: ChunkKind;
  variantOf?: string;
  knobValues?: Record<string, unknown>;
}

interface ResolvedBlobSlot {
  hash: string;
  byteLength: number;
  chunkId: ChunkKind;
  byteOffset: number;
  canonicalAssetId: string;
}

function pickCanonicalAsset<T extends ResolvedAssetInput>(
  group: readonly T[],
  variantTargets: ReadonlySet<string>,
): T {
  const sorted = [...group].sort((a, b) => {
    const aBase = a.chunkId === "base" ? 0 : 1;
    const bBase = b.chunkId === "base" ? 0 : 1;
    if (aBase !== bBase) return aBase - bBase;

    const aVar = a.variantOf ? 1 : 0;
    const bVar = b.variantOf ? 1 : 0;
    if (aVar !== bVar) return aVar - bVar;

    const aTarget = variantTargets.has(a.id) ? 0 : 1;
    const bTarget = variantTargets.has(b.id) ? 0 : 1;
    if (aTarget !== bTarget) return aTarget - bTarget;

    const aKind = a.kind === "model" ? 0 : 1;
    const bKind = b.kind === "model" ? 0 : 1;
    if (aKind !== bKind) return aKind - bKind;

    return compareCodepoint(a.id, b.id);
  });
  return sorted[0]!;
}

function resolveTextureAssetId(id: string): string {
  // ManifestSchema allows a model and a texture to share the same `id` (e.g. `fantasy-rivals/Mystic_Arms`).
  // Always namespace textures in `assets.id` so PRIMARY KEY collisions cannot occur.
  return id.startsWith("texture:") ? id : `texture:${id}`;
}

function resolveModelLicence(
  id: string,
  packSlug: string | undefined,
  file: string,
  catalogModel: ParsedCatalogModel | undefined,
  packBySlug: ReadonlyMap<string, ParsedCatalogPack>,
  options: BuildBakedAssetIndexOptions,
  creditIndex: ReadonlyMap<string, CreditEntry>,
): LicenceClassification {
  const override = options.assetLicences?.[id];
  if (override !== undefined) {
    const norm = normalizeLicenceInput(override);
    return classifyAssetLicence(
      { ...norm, sourcePath: norm.sourcePath ?? file, packSlug: norm.packSlug ?? packSlug },
      creditIndex,
    );
  }

  const packMeta = packSlug ? packBySlug.get(packSlug) : undefined;
  const rawLicense = catalogModel?.license ?? packMeta?.license;
  const rawLicObj =
    rawLicense && typeof rawLicense === "object"
      ? rawLicense
      : typeof rawLicense === "string"
        ? { name: rawLicense }
        : undefined;

  const packOverride = packSlug ? normalizeLicenceInput(options.packLicences?.[packSlug]) : undefined;

  const merged: AssetLicenceInput = {
    name:
      catalogModel?.licence ??
      rawLicObj?.name ??
      packMeta?.licence ??
      packOverride?.name ??
      null,
    author: rawLicObj?.author ?? packOverride?.author ?? null,
    page: rawLicObj?.page ?? packOverride?.page ?? null,
    licenceLane:
      catalogModel?.licenceLane ??
      catalogModel?.licence_lane ??
      packMeta?.licenceLane ??
      packOverride?.licenceLane ??
      null,
    credit: catalogModel?.credit ?? packMeta?.credit ?? packOverride?.credit ?? null,
    derivedFromMjs: catalogModel?.derivedFromMjs ?? packOverride?.derivedFromMjs,
    rawSourceRestricted: catalogModel?.rawSourceRestricted ?? packOverride?.rawSourceRestricted,
    sourcePath: file,
    packSlug,
    packSource: packMeta?.source ?? packOverride?.packSource,
  };

  return classifyAssetLicence(merged, creditIndex);
}

function collectClipInputs(
  options: BuildBakedAssetIndexOptions,
  assetsRoot: string,
  creditIndex: ReadonlyMap<string, CreditEntry>,
): Array<{
  id: string;
  assetId: string;
  family: string;
  verb: string;
  frames: number;
  rate: number;
  hash: string;
  classification: LicenceClassification;
}> {
  const out: Array<{
    id: string;
    assetId: string;
    family: string;
    verb: string;
    frames: number;
    rate: number;
    hash: string;
    classification: LicenceClassification;
  }> = [];

  for (const clip of options.clips ?? []) {
    let hash = clip.hash;
    if (clip.file) {
      const full = resolveContainedFile(assetsRoot, clip.file, `clip "${clip.id}"`);
      if (!existsSync(full)) {
        throw new BakedStoreValidationError(`clip "${clip.id}": file "${clip.file}" is missing`, [
          `clip "${clip.id}": missing "${clip.file}"`,
        ]);
      }
      hash = sha256Hex(readFileSync(full));
    }
    if (!hash) {
      throw new BakedStoreValidationError(`clip "${clip.id}": either file or hash is required`, [
        `clip "${clip.id}": missing file and hash`,
      ]);
    }
    const licInput = normalizeLicenceInput(clip.licence);
    const classification = classifyAssetLicence(
      {
        ...licInput,
        author: licInput.author ?? clip.author,
        credit: licInput.credit ?? clip.credit,
        derivedFromMjs: licInput.derivedFromMjs ?? clip.derivedFromMjs,
        rawSourceRestricted: licInput.rawSourceRestricted ?? clip.rawSourceRestricted,
        sourcePath: licInput.sourcePath ?? clip.file,
      },
      creditIndex,
    );
    out.push({
      id: clip.id,
      assetId: clip.assetId,
      family: clip.family,
      verb: clip.verb,
      frames: clip.frames,
      rate: clip.rate,
      hash,
      classification,
    });
  }

  let animManifest = options.animationsManifest;
  if (!animManifest && options.animationsManifestPath) {
    animManifest = loadJsonFile(options.animationsManifestPath, "animations manifest") as AnimationManifest;
  }
  if (animManifest) {
    const sourceById = new Map(animManifest.sources.map((s) => [s.id, s]));
    const animRoot =
      options.animationsRoot ??
      (options.animationsManifestPath ? dirname(options.animationsManifestPath) : assetsRoot);
    const sourceHashCache = new Map<string, string>();
    const defaultRate = 30;

    for (const clip of animManifest.clips) {
      const src = sourceById.get(clip.source);
      if (!src) {
        throw new BakedStoreValidationError(
          `animation clip "${clip.name}" references unknown source "${clip.source}"`,
          [`animation clip "${clip.name}": unknown source "${clip.source}"`],
        );
      }
      let srcHash = sourceHashCache.get(src.id);
      if (!srcHash) {
        const srcFull = resolveContainedFile(animRoot, src.file, `animation source "${src.id}"`);
        if (existsSync(srcFull)) {
          srcHash = sha256Hex(readFileSync(srcFull));
        } else {
          srcHash = sha256Hex(`${src.id}:${src.file}:${src.url}`);
        }
        sourceHashCache.set(src.id, srcHash);
      }
      const clipHash = sha256Hex(`${srcHash}:${clip.name}:${clip.duration}:${clip.loop}`);
      const classification = classifyAssetLicence(
        {
          name: src.license,
          author: src.author,
          page: src.url,
          sourcePath: src.file,
          packSlug: src.id,
        },
        creditIndex,
      );
      const frames = Math.max(1, Math.round(clip.duration * defaultRate));
      out.push({
        id: clip.name,
        assetId: `anim:${src.id}`,
        family: src.reference ? "reference" : "locomotion",
        verb: clip.name.toLowerCase(),
        frames,
        rate: defaultRate,
        hash: clipHash,
        classification,
      });
    }
  }

  return out.sort((a, b) => compareCodepoint(a.id, b.id));
}

interface ChunkToInsert {
  id: ChunkKind;
  hash: string;
  bytes: number;
  kind: ChunkKind;
}

interface HashedAssetRecord extends ResolvedAssetInput {
  hash: string;
  byteLength: number;
}

interface ClipToInsert {
  id: string;
  assetId: string;
  family: string;
  verb: string;
  frames: number;
  rate: number;
  hash: string;
  classification: LicenceClassification;
}

interface VariantToInsert {
  assetId: string;
  knobJson: string;
  meshAssetId: string;
}

function loadAndValidateInputs(
  options: BuildBakedAssetIndexOptions,
  assetsRoot: string,
): {
  creditIndex: Map<string, CreditEntry>;
  manifest: AssetManifest;
  catalog: ParsedCatalog | null;
} {
  let creditsRaw = options.credits;
  if (creditsRaw === undefined && options.creditsPath) {
    creditsRaw = loadJsonFile(options.creditsPath, "credits.json");
  }
  const creditIndex = buildCreditIndex(creditsRaw);

  const manifestPath = options.manifestPath ?? join(assetsRoot, "manifest.json");
  const manifestRaw = options.manifest ?? loadJsonFile(manifestPath, "manifest.json");
  const manifest = parseManifestJSON(manifestRaw);

  const defaultCatalogPath = join(assetsRoot, "catalog.json");
  let catalog: ParsedCatalog | null = null;
  if (options.catalog !== undefined) {
    catalog = CatalogSchema.parse(options.catalog);
  } else if (options.catalogPath) {
    catalog = CatalogSchema.parse(loadJsonFile(options.catalogPath, "catalog.json"));
  } else if (existsSync(defaultCatalogPath)) {
    catalog = CatalogSchema.parse(loadJsonFile(defaultCatalogPath, "catalog.json"));
  }

  const existingFiles = new Set<string>();
  for (const entry of [...manifest.models, ...manifest.textures]) {
    const resolved = resolveContainedFile(assetsRoot, entry.file, `manifest entry "${entry.id}"`);
    if (existsSync(resolved)) existingFiles.add(entry.file);
  }
  const manifestDiagnostics = checkManifestFiles(manifest, existingFiles);
  if (manifestDiagnostics.length > 0) {
    throw new BakedStoreValidationError(
      `Manifest completeness check failed (${manifestDiagnostics.length} missing file(s)): ${manifestDiagnostics[0]}`,
      manifestDiagnostics,
    );
  }

  return { creditIndex, manifest, catalog };
}

function resolveAssetsAndKnobs(
  options: BuildBakedAssetIndexOptions,
  assetsRoot: string,
  manifest: AssetManifest,
  catalog: ParsedCatalog | null,
  creditIndex: ReadonlyMap<string, CreditEntry>,
): { resolvedAssets: ResolvedAssetInput[]; knobsToInsert: BakedKnobInput[] } {
  const packBySlug = new Map<string, ParsedCatalogPack>();
  for (const p of catalog?.packs ?? []) packBySlug.set(p.slug, p);

  const catalogModelById = new Map<string, ParsedCatalogModel>();
  for (const m of catalog?.models ?? []) {
    if (catalogModelById.has(m.id)) {
      throw new BakedStoreValidationError(`Duplicate model id "${m.id}" in catalog.json`, [
        `Duplicate catalog model id "${m.id}"`,
      ]);
    }
    catalogModelById.set(m.id, m);
  }

  const basePackSet = new Set(options.basePacks ?? []);
  const modelRecords: Array<{ id: string; file: string; pack?: string; category?: string; cat?: ParsedCatalogModel }> =
    [];
  const seenModelIds = new Set<string>();

  for (const m of manifest.models) {
    const cat = catalogModelById.get(m.id);
    if (cat && cat.file !== m.file) {
      throw new BakedStoreValidationError(
        `Model "${m.id}" file mismatch between manifest ("${m.file}") and catalog ("${cat.file}")`,
        [`Model "${m.id}" file mismatch`],
      );
    }
    const pack = cat?.pack ?? (m.id.includes("/") ? m.id.slice(0, m.id.indexOf("/")) : undefined);
    seenModelIds.add(m.id);
    modelRecords.push({ id: m.id, file: m.file, pack, category: cat?.category, cat });
  }

  for (const cat of catalog?.models ?? []) {
    if (seenModelIds.has(cat.id)) continue;
    const resolved = resolveContainedFile(assetsRoot, cat.file, `catalog model "${cat.id}"`);
    if (!existsSync(resolved)) {
      throw new BakedStoreValidationError(
        `catalog model "${cat.id}": file "${cat.file}" is missing from "${assetsRoot}"`,
        [`catalog model "${cat.id}": missing "${cat.file}"`],
      );
    }
    seenModelIds.add(cat.id);
    modelRecords.push({ id: cat.id, file: cat.file, pack: cat.pack, category: cat.category, cat });
  }

  const pickChunk = (info: {
    id: string;
    kind: AssetKind;
    pack?: string;
    category?: string;
    file: string;
  }): ChunkKind => {
    if (options.chunkForAsset) return validateChunkId(options.chunkForAsset(info));
    if (info.kind === "model") {
      const cat = catalogModelById.get(info.id);
      if (cat?.chunkId) return validateChunkId(cat.chunkId);
      if (cat?.region) return validateChunkId(`region:${cat.region}`);
    }
    if (info.pack) {
      return basePackSet.has(info.pack) ? "base" : (`kit:${info.pack}` as ChunkKind);
    }
    return "base";
  };

  const resolvedAssets: ResolvedAssetInput[] = [];
  const knobsToInsert: BakedKnobInput[] = [...(options.knobs ?? [])];

  for (const m of modelRecords) {
    const classification = resolveModelLicence(m.id, m.pack, m.file, m.cat, packBySlug, options, creditIndex);
    const chunkId = pickChunk({ id: m.id, kind: "model", pack: m.pack, category: m.category, file: m.file });
    const variantOf = m.cat?.variantOf ?? m.cat?.meshAssetId;
    let knobValues = m.cat?.knobValues;
    if (m.cat?.knobs) {
      if (Array.isArray(m.cat.knobs)) {
        for (const k of m.cat.knobs) {
          knobsToInsert.push({
            assetId: m.id,
            knob: k.knob,
            type: k.type,
            min: k.min ?? null,
            max: k.max ?? null,
            def: k.def ?? null,
          });
        }
      } else if (!knobValues) {
        knobValues = m.cat.knobs;
      }
    }
    resolvedAssets.push({
      id: m.id,
      kind: "model",
      file: m.file,
      pack: m.pack,
      category: m.category,
      classification,
      chunkId,
      variantOf,
      knobValues,
    });
  }

  for (const t of manifest.textures) {
    const storeId = resolveTextureAssetId(t.id);
    const pack = t.id.includes("/") ? t.id.slice(0, t.id.indexOf("/")) : undefined;
    const override = options.assetLicences?.[storeId] ?? options.assetLicences?.[t.id];
    const classification =
      override !== undefined
        ? classifyAssetLicence(
            { ...normalizeLicenceInput(override), sourcePath: t.file, packSlug: pack },
            creditIndex,
          )
        : resolveModelLicence(t.id, pack, t.file, undefined, packBySlug, options, creditIndex);
    const chunkId = pickChunk({ id: storeId, kind: "texture", pack, file: t.file });
    resolvedAssets.push({
      id: storeId,
      kind: "texture",
      file: t.file,
      pack,
      classification,
      chunkId,
    });
  }

  resolvedAssets.sort((a, b) => compareCodepoint(a.id, b.id));
  knobsToInsert.sort((a, b) => compareCodepoint(a.assetId, b.assetId) || compareCodepoint(a.knob, b.knob));
  return { resolvedAssets, knobsToInsert };
}

function hashAndDedupeAssets(
  assetsRoot: string,
  resolvedAssets: readonly ResolvedAssetInput[],
): {
  assetsWithHashes: HashedAssetRecord[];
  slotByHash: Map<string, ResolvedBlobSlot>;
  chunksToInsert: ChunkToInsert[];
} {
  const fileHashCache = new Map<string, { hash: string; byteLength: number }>();
  const assetsWithHashes: HashedAssetRecord[] = resolvedAssets.map((asset) => {
    let cached = fileHashCache.get(asset.file);
    if (!cached) {
      const fullPath = resolveContainedFile(assetsRoot, asset.file, `asset "${asset.id}"`);
      const bytes = readFileSync(fullPath);
      cached = { hash: sha256Hex(bytes), byteLength: bytes.byteLength };
      fileHashCache.set(asset.file, cached);
    }
    return { ...asset, hash: cached.hash, byteLength: cached.byteLength };
  });

  const groupsByHash = new Map<string, HashedAssetRecord[]>();
  const variantTargets = new Set<string>();
  for (const asset of assetsWithHashes) {
    if (asset.variantOf) variantTargets.add(asset.variantOf);
    const group = groupsByHash.get(asset.hash) ?? [];
    group.push(asset);
    groupsByHash.set(asset.hash, group);
  }

  const slotByHash = new Map<string, ResolvedBlobSlot>();
  const chunkBlobs = new Map<ChunkKind, Array<{ hash: string; byteLength: number }>>();
  for (const hash of [...groupsByHash.keys()].sort(compareCodepoint)) {
    const group = groupsByHash.get(hash)!;
    const canonical = pickCanonicalAsset(group, variantTargets);
    const list = chunkBlobs.get(canonical.chunkId) ?? [];
    list.push({ hash, byteLength: canonical.byteLength });
    chunkBlobs.set(canonical.chunkId, list);
    slotByHash.set(hash, {
      hash,
      byteLength: canonical.byteLength,
      chunkId: canonical.chunkId,
      byteOffset: 0,
      canonicalAssetId: canonical.id,
    });
  }

  const chunksToInsert: ChunkToInsert[] = [];
  for (const chunkId of [...chunkBlobs.keys()].sort(compareCodepoint)) {
    const blobs = chunkBlobs.get(chunkId)!;
    let offset = 0;
    const digestLines: string[] = [];
    for (const blob of blobs) {
      const slot = slotByHash.get(blob.hash)!;
      slot.byteOffset = offset;
      digestLines.push(`${blob.hash}:${offset}:${blob.byteLength}`);
      offset += blob.byteLength;
    }
    chunksToInsert.push({
      id: chunkId,
      kind: chunkId,
      bytes: offset,
      hash: sha256Hex(digestLines.join("\n")),
    });
  }

  return { assetsWithHashes, slotByHash, chunksToInsert };
}

function buildCollapsedVariants(
  assetsWithHashes: readonly HashedAssetRecord[],
  slotByHash: ReadonlyMap<string, ResolvedBlobSlot>,
  explicitVariants: readonly BakedVariantInput[],
): VariantToInsert[] {
  const assetById = new Map(assetsWithHashes.map((a) => [a.id, a]));
  const variantsMap = new Map<string, VariantToInsert>();
  const putVariant = (assetId: string, knobJson: string, meshAssetId: string): void => {
    variantsMap.set(`${assetId}\0${knobJson}`, { assetId, knobJson, meshAssetId });
  };

  for (const asset of assetsWithHashes) {
    const slot = slotByHash.get(asset.hash)!;
    if (asset.variantOf) {
      const targetAsset = assetById.get(asset.variantOf);
      if (!targetAsset) {
        throw new BakedStoreValidationError(
          `Asset "${asset.id}" references missing variantOf mesh "${asset.variantOf}"`,
          [`Missing variantOf target "${asset.variantOf}"`],
        );
      }
      if (targetAsset.hash !== asset.hash) {
        throw new BakedStoreValidationError(
          `Asset "${asset.id}" variantOf "${asset.variantOf}" hash mismatch (${asset.hash} !== ${targetAsset.hash})`,
          [`variantOf hash mismatch on "${asset.id}"`],
        );
      }
    }
    if (asset.id !== slot.canonicalAssetId) {
      putVariant(asset.id, canonicalJson(asset.knobValues ?? {}), slot.canonicalAssetId);
    } else if (asset.knobValues && Object.keys(asset.knobValues).length > 0) {
      putVariant(asset.id, canonicalJson(asset.knobValues), slot.canonicalAssetId);
    }
  }

  for (const v of explicitVariants) {
    const targetAsset = assetById.get(v.meshAssetId);
    if (!targetAsset) {
      throw new BakedStoreValidationError(
        `Explicit variant "${v.assetId}" references unknown meshAssetId "${v.meshAssetId}"`,
        [`Unknown meshAssetId "${v.meshAssetId}"`],
      );
    }
    const canonicalMeshId = slotByHash.get(targetAsset.hash)!.canonicalAssetId;
    putVariant(v.assetId, canonicalJson(v.knobs), canonicalMeshId);
  }

  return [...variantsMap.values()].sort(
    (a, b) => compareCodepoint(a.assetId, b.assetId) || compareCodepoint(a.knobJson, b.knobJson),
  );
}

function persistBakedStoreTransaction(
  db: DatabaseSync,
  payload: {
    target: BakeTarget;
    manifest: AssetManifest;
    converterVersion: number | undefined;
    chunksToInsert: readonly ChunkToInsert[];
    assetsWithHashes: readonly HashedAssetRecord[];
    slotByHash: ReadonlyMap<string, ResolvedBlobSlot>;
    variantsToInsert: readonly VariantToInsert[];
    resolvedClips: readonly ClipToInsert[];
    knobsToInsert: readonly BakedKnobInput[];
  },
): void {
  db.exec(SCHEMA_SQL);
  db.exec("BEGIN IMMEDIATE;");
  try {
    const insertMeta = db.prepare("INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)");
    insertMeta.run("schema_version", String(BAKED_STORE_SCHEMA_VERSION));
    insertMeta.run("spec", "BAKED-ASSET-STORE-SPEC-B0");
    insertMeta.run("target", payload.target);
    insertMeta.run("manifest_name", payload.manifest.name);
    insertMeta.run("manifest_version", payload.manifest.version);
    if (payload.converterVersion !== undefined) {
      insertMeta.run("converter_version", String(payload.converterVersion));
    }

    const insertChunk = db.prepare("INSERT INTO chunks (id, hash, bytes, kind) VALUES (?, ?, ?, ?)");
    for (const c of payload.chunksToInsert) {
      insertChunk.run(c.id, c.hash, c.bytes, c.kind);
    }

    const insertAsset = db.prepare(
      "INSERT INTO assets (id, kind, source, hash, chunk_id, byte_offset, byte_length, licence_lane, credit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const a of payload.assetsWithHashes) {
      const slot = payload.slotByHash.get(a.hash)!;
      insertAsset.run(
        a.id,
        a.kind,
        a.file,
        a.hash,
        slot.chunkId,
        slot.byteOffset,
        slot.byteLength,
        a.classification.licenceLane,
        a.classification.credit,
      );
    }

    const insertVariant = db.prepare(
      "INSERT INTO variants (asset_id, knob_json, mesh_asset_id) VALUES (?, ?, ?)",
    );
    for (const v of payload.variantsToInsert) {
      insertVariant.run(v.assetId, v.knobJson, v.meshAssetId);
    }

    const insertClip = db.prepare(
      "INSERT INTO clips (id, asset_id, family, verb, licence_lane, hash, frames, rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const c of payload.resolvedClips) {
      insertClip.run(c.id, c.assetId, c.family, c.verb, c.classification.licenceLane, c.hash, c.frames, c.rate);
    }

    const insertKnob = db.prepare(
      "INSERT OR REPLACE INTO knobs (asset_id, knob, type, min, max, def) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const k of payload.knobsToInsert) {
      insertKnob.run(k.assetId, k.knob, k.type, k.min ?? null, k.max ?? null, k.def ?? null);
    }

    db.exec("COMMIT;");
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK;");
    throw err;
  }
}

/**
 * Build a deterministic, content-addressed, licence-validated Baked Asset Store SQLite index
 * from `manifest.json`, optional `catalog.json`, optional `credits.json`, and files on disk.
 *
 * Fail-closed: rejects invalid manifests, missing files, path escapes, licence-lane violations,
 * and unresolvable variant references before touching `dbPath`.
 */
export function buildBakedAssetIndex(options: BuildBakedAssetIndexOptions): BuildBakedAssetIndexResult {
  const target: BakeTarget = options.target ?? "own-game";
  const assetsRoot = resolve(options.assetsRoot);
  const overwrite = options.overwrite ?? true;

  if (options.dbPath !== ":memory:" && !overwrite && existsSync(options.dbPath)) {
    throw new BakedStoreValidationError(`Baked store already exists at "${options.dbPath}"`, [
      `Target exists: "${options.dbPath}"`,
    ]);
  }

  const { creditIndex, manifest, catalog } = loadAndValidateInputs(options, assetsRoot);
  const { resolvedAssets, knobsToInsert } = resolveAssetsAndKnobs(
    options,
    assetsRoot,
    manifest,
    catalog,
    creditIndex,
  );
  const resolvedClips = collectClipInputs(options, assetsRoot, creditIndex);

  validateBakeLicences(
    [
      ...resolvedAssets.map((a) => ({ id: a.id, kind: a.kind, classification: a.classification })),
      ...resolvedClips.map((c) => ({ id: c.id, kind: "clip" as const, classification: c.classification })),
    ],
    target,
  );

  const { assetsWithHashes, slotByHash, chunksToInsert } = hashAndDedupeAssets(assetsRoot, resolvedAssets);
  const variantsToInsert = buildCollapsedVariants(assetsWithHashes, slotByHash, options.variants ?? []);

  const isMemory = options.dbPath === ":memory:";
  const stagingPath = isMemory
    ? ":memory:"
    : `${options.dbPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (!isMemory) {
    mkdirSync(dirname(resolve(options.dbPath)), { recursive: true });
  }

  const db = new DatabaseSync(stagingPath);
  try {
    persistBakedStoreTransaction(db, {
      target,
      manifest,
      converterVersion: catalog?.converterVersion,
      chunksToInsert,
      assetsWithHashes,
      slotByHash,
      variantsToInsert,
      resolvedClips,
      knobsToInsert,
    });

    let store: BakedAssetStore;
    if (isMemory) {
      store = new BakedAssetStore(db, ":memory:", false);
    } else {
      db.close();
      renameSync(stagingPath, options.dbPath);
      store = openBakedAssetStore(options.dbPath, { readOnly: true });
    }

    return {
      store,
      target,
      assetCount: assetsWithHashes.length,
      clipCount: resolvedClips.length,
      chunkCount: chunksToInsert.length,
      dedupeReport: store.dedupeReport(),
      licenceCoverageReport: store.licenceCoverageReport(),
    };
  } catch (err) {
    if (db.isOpen) db.close();
    if (!isMemory) rmSync(stagingPath, { force: true });
    throw err;
  }
}

/**
 * Open an existing Baked Asset Store SQLite database (read-only by default for file paths)
 * and verify that all required schema tables exist.
 */
export function openBakedAssetStore(dbPath: string, options: OpenBakedAssetStoreOptions = {}): BakedAssetStore {
  const isMemory = dbPath === ":memory:";
  const readOnly = options.readOnly ?? !isMemory;
  if (!isMemory && !existsSync(dbPath)) {
    throw new BakedStoreValidationError(`Baked asset store not found: "${dbPath}"`, [
      `Missing store "${dbPath}"`,
    ]);
  }
  const db = new DatabaseSync(dbPath, { readOnly });
  try {
    const existingTables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name)),
    );
    const missing = REQUIRED_TABLES.filter((t) => !existingTables.has(t));
    if (missing.length > 0) {
      throw new BakedStoreValidationError(
        `Invalid baked asset store "${dbPath}": missing table(s) ${missing.join(", ")}`,
        missing.map((t) => `Missing table "${t}"`),
      );
    }
    return new BakedAssetStore(db, dbPath, readOnly);
  } catch (err) {
    if (db.isOpen) db.close();
    throw err;
  }
}

function unwrapDb(storeOrDb: BakedAssetStore | DatabaseSync): DatabaseSync {
  return storeOrDb instanceof BakedAssetStore ? storeOrDb.db : storeOrDb;
}

/**
 * Look up which chunk holds `assetId`, along with its SHA-256 hash, byte slice,
 * licence lane, credit, and canonical deduplicated mesh id.
 */
export function lookupAssetChunk(
  storeOrDb: BakedAssetStore | DatabaseSync,
  assetId: string,
  kind?: AssetKind,
): AssetChunkLookup | null {
  const db = unwrapDb(storeOrDb);
  const query = `
    SELECT
      a.id AS asset_id,
      a.kind AS kind,
      a.source AS source,
      a.hash AS hash,
      a.chunk_id AS chunk_id,
      c.kind AS chunk_kind,
      c.hash AS chunk_hash,
      c.bytes AS chunk_bytes,
      a.byte_offset AS byte_offset,
      a.byte_length AS byte_length,
      a.licence_lane AS licence_lane,
      a.credit AS credit
    FROM assets a
    JOIN chunks c ON c.id = a.chunk_id
    WHERE a.id = ?
  `;

  const candidates: Array<{ id: string; kindFilter?: AssetKind }> = [];
  if (kind === "texture") {
    candidates.push({ id: assetId, kindFilter: "texture" });
    if (!assetId.startsWith("texture:")) candidates.push({ id: `texture:${assetId}`, kindFilter: "texture" });
  } else if (kind) {
    candidates.push({ id: assetId, kindFilter: kind });
  } else {
    candidates.push({ id: assetId });
    if (!assetId.startsWith("texture:")) candidates.push({ id: `texture:${assetId}` });
  }

  let row: Record<string, unknown> | undefined;
  for (const candidate of candidates) {
    const sql = candidate.kindFilter ? `${query} AND a.kind = ?` : query;
    const params: SQLInputValue[] = candidate.kindFilter ? [candidate.id, candidate.kindFilter] : [candidate.id];
    row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    if (row) break;
  }
  if (!row) return null;

  const foundId = String(row.asset_id);
  const variantRow = db
    .prepare("SELECT mesh_asset_id FROM variants WHERE asset_id = ? LIMIT 1")
    .get(foundId) as Record<string, unknown> | undefined;
  const canonicalMeshAssetId = variantRow ? String(variantRow.mesh_asset_id) : foundId;

  return {
    assetId: foundId,
    kind: String(row.kind) as AssetKind,
    source: String(row.source),
    hash: String(row.hash),
    chunkId: String(row.chunk_id),
    chunkKind: String(row.chunk_kind),
    chunkHash: String(row.chunk_hash),
    chunkBytes: Number(row.chunk_bytes),
    byteOffset: Number(row.byte_offset),
    byteLength: Number(row.byte_length),
    licenceLane: String(row.licence_lane) as LicenceLane,
    credit: row.credit === null ? null : String(row.credit),
    canonicalMeshAssetId,
    deduplicated: canonicalMeshAssetId !== foundId,
  };
}

function parseVariantRow(row: Record<string, unknown>): VariantEntry {
  const knobJson = String(row.knob_json);
  return {
    assetId: String(row.asset_id),
    knobJson,
    knobs: JSON.parse(knobJson) as Record<string, unknown>,
    meshAssetId: String(row.mesh_asset_id),
  };
}

/**
 * Retrieve variant collapse and knob definitions for `assetId` (whether queried by
 * the collapsed variant listing ID or the canonical mesh asset ID).
 */
export function getVariantInfo(
  storeOrDb: BakedAssetStore | DatabaseSync,
  assetId: string,
): VariantInfo | null {
  const db = unwrapDb(storeOrDb);
  const assetRow = db.prepare("SELECT id FROM assets WHERE id = ?").get(assetId) as
    | Record<string, unknown>
    | undefined;
  const ownVariantRows = db
    .prepare("SELECT asset_id, knob_json, mesh_asset_id FROM variants WHERE asset_id = ? ORDER BY knob_json")
    .all(assetId) as Record<string, unknown>[];

  if (!assetRow && ownVariantRows.length === 0) return null;

  const ownVariants = ownVariantRows.map(parseVariantRow);
  const canonicalMeshAssetId = ownVariants[0]?.meshAssetId ?? assetId;
  const meshVariantRows = db
    .prepare(
      "SELECT asset_id, knob_json, mesh_asset_id FROM variants WHERE mesh_asset_id = ? ORDER BY asset_id, knob_json",
    )
    .all(canonicalMeshAssetId) as Record<string, unknown>[];
  const meshVariants = meshVariantRows.map(parseVariantRow);

  const knobLookupIds = canonicalMeshAssetId === assetId ? [assetId] : [assetId, canonicalMeshAssetId];
  const placeholders = knobLookupIds.map(() => "?").join(", ");
  const knobRows = db
    .prepare(
      `SELECT asset_id, knob, type, min, max, def FROM knobs WHERE asset_id IN (${placeholders}) ORDER BY asset_id, knob`,
    )
    .all(...knobLookupIds) as Record<string, unknown>[];

  return {
    assetId,
    canonicalMeshAssetId,
    isCollapsedVariant: canonicalMeshAssetId !== assetId,
    ownVariants,
    meshVariants,
    knobs: knobRows.map((k) => ({
      assetId: String(k.asset_id),
      knob: String(k.knob),
      type: String(k.type),
      min: k.min === null ? null : Number(k.min),
      max: k.max === null ? null : Number(k.max),
      def: k.def === null ? null : Number(k.def),
    })),
  };
}

/** Compute SHA-256 content-hash deduplication and chunk byte savings report. */
export function dedupeReport(storeOrDb: BakedAssetStore | DatabaseSync): DedupeReport {
  const db = unwrapDb(storeOrDb);
  const totals = db
    .prepare(
      `SELECT
        COUNT(*) AS total_assets,
        COUNT(DISTINCT hash) AS unique_blobs,
        COALESCE(SUM(byte_length), 0) AS raw_bytes
      FROM assets`,
    )
    .get() as Record<string, unknown>;

  const chunkRows = db
    .prepare(
      `SELECT c.id, c.kind, c.hash, c.bytes, COUNT(a.id) AS asset_count
       FROM chunks c
       LEFT JOIN assets a ON a.chunk_id = c.id
       GROUP BY c.id
       ORDER BY c.id`,
    )
    .all() as Record<string, unknown>[];

  const variantCountRow = db.prepare("SELECT COUNT(*) AS count FROM variants").get() as Record<string, unknown>;

  const dupGroupsRows = db
    .prepare(
      `SELECT
        a.hash AS hash,
        MIN(a.byte_length) AS byte_length,
        COUNT(*) AS group_count
       FROM assets a
       GROUP BY a.hash
       HAVING COUNT(*) > 1
       ORDER BY (COUNT(*) - 1) * MIN(a.byte_length) DESC, a.hash ASC`,
    )
    .all() as Record<string, unknown>[];

  const topDuplicates: DedupeGroupSummary[] = dupGroupsRows.map((g) => {
    const hash = String(g.hash);
    const byteLength = Number(g.byte_length);
    const groupCount = Number(g.group_count);
    const memberRows = db
      .prepare("SELECT id FROM assets WHERE hash = ? ORDER BY id")
      .all(hash) as Record<string, unknown>[];
    const assetIds = memberRows.map((m) => String(m.id));
    const variantTarget = db
      .prepare(
        `SELECT v.mesh_asset_id
         FROM variants v
         JOIN assets a ON a.id = v.asset_id
         WHERE a.hash = ?
         LIMIT 1`,
      )
      .get(hash) as Record<string, unknown> | undefined;
    const canonicalMeshAssetId = variantTarget ? String(variantTarget.mesh_asset_id) : assetIds[0]!;
    return {
      hash,
      canonicalMeshAssetId,
      byteLength,
      assetIds,
      duplicateCount: groupCount - 1,
      bytesSaved: (groupCount - 1) * byteLength,
    };
  });

  const totalAssets = Number(totals.total_assets);
  const uniqueBlobs = Number(totals.unique_blobs);
  const rawBytes = Number(totals.raw_bytes);
  const dedupedBytes = chunkRows.reduce((sum, c) => sum + Number(c.bytes), 0);
  const savedBytes = Math.max(0, rawBytes - dedupedBytes);

  return {
    totalAssets,
    uniqueBlobs,
    collapsedDuplicates: Math.max(0, totalAssets - uniqueBlobs),
    variantRows: Number(variantCountRow.count),
    duplicateGroups: dupGroupsRows.length,
    rawBytes,
    dedupedBytes,
    savedBytes,
    dedupeRatio: rawBytes > 0 ? savedBytes / rawBytes : 0,
    chunkCount: chunkRows.length,
    chunks: chunkRows.map((c) => ({
      id: String(c.id),
      kind: String(c.kind),
      hash: String(c.hash),
      bytes: Number(c.bytes),
      assetCount: Number(c.asset_count),
    })),
    topDuplicates,
  };
}

/** Compute licence-lane coverage and shipped-prototype-pack readiness across `assets` and `clips`. */
export function licenceCoverageReport(storeOrDb: BakedAssetStore | DatabaseSync): LicenceCoverageReport {
  const db = unwrapDb(storeOrDb);
  const assetLaneRows = db
    .prepare("SELECT licence_lane, COUNT(*) AS count FROM assets GROUP BY licence_lane ORDER BY licence_lane")
    .all() as Record<string, unknown>[];
  const clipLaneRows = db
    .prepare("SELECT licence_lane, COUNT(*) AS count FROM clips GROUP BY licence_lane ORDER BY licence_lane")
    .all() as Record<string, unknown>[];
  const creditRow = db
    .prepare("SELECT COUNT(*) AS count FROM assets WHERE credit IS NOT NULL AND length(trim(credit)) > 0")
    .get() as Record<string, unknown>;
  const unreadyRows = db
    .prepare(
      `SELECT id, kind, source, licence_lane, credit
       FROM assets
       WHERE licence_lane != 'shipped-prototype-pack'
       ORDER BY id`,
    )
    .all() as Record<string, unknown>[];

  const byLane: Record<string, number> = {};
  let totalAssets = 0;
  for (const r of assetLaneRows) {
    const lane = String(r.licence_lane);
    const count = Number(r.count);
    byLane[lane] = count;
    totalAssets += count;
  }

  const clipsByLane: Record<string, number> = {};
  let totalClips = 0;
  for (const r of clipLaneRows) {
    const lane = String(r.licence_lane);
    const count = Number(r.count);
    clipsByLane[lane] = count;
    totalClips += count;
  }

  const missingOrUnknownAssets = byLane.unknown ?? 0;
  const missingOrUnknownClips = clipsByLane.unknown ?? 0;
  const restrictedAssets = byLane.restricted ?? 0;
  const restrictedClips = clipsByLane.restricted ?? 0;
  const shippedPackEligibleAssets = byLane["shipped-prototype-pack"] ?? 0;
  const ownGameOnlyAssets = byLane["own-game"] ?? 0;
  const coveredAssets = totalAssets - missingOrUnknownAssets;
  const coveredClips = totalClips - missingOrUnknownClips;

  return {
    totalAssets,
    totalClips,
    coveredAssets,
    coveredClips,
    missingOrUnknownAssets,
    missingOrUnknownClips,
    restrictedAssets,
    restrictedClips,
    shippedPackEligibleAssets,
    ownGameOnlyAssets,
    assetsWithCredit: Number(creditRow.count),
    coverageRatio: totalAssets > 0 ? coveredAssets / totalAssets : 1,
    byLane,
    clipsByLane,
    unreadyForShippedPack: unreadyRows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      source: String(r.source),
      licenceLane: String(r.licence_lane),
      credit: r.credit === null ? null : String(r.credit),
    })),
  };
}

export class BakedAssetStore implements Disposable {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly readOnly: boolean;

  constructor(db: DatabaseSync, path: string, readOnly: boolean) {
    this.db = db;
    this.path = path;
    this.readOnly = readOnly;
  }

  lookupAssetChunk(assetId: string, kind?: AssetKind): AssetChunkLookup | null {
    return lookupAssetChunk(this.db, assetId, kind);
  }

  getVariantInfo(assetId: string): VariantInfo | null {
    return getVariantInfo(this.db, assetId);
  }

  dedupeReport(): DedupeReport {
    return dedupeReport(this.db);
  }

  licenceCoverageReport(): LicenceCoverageReport {
    return licenceCoverageReport(this.db);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
