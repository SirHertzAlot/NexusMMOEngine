/**
 * The town generator's rules for the editor dev host: `<repo>/content/settlements/rules.json`
 * (`@mmo-engine/settlement` rules.ts), which the settlement bakes read. Loopback routes (wired in host.ts):
 *
 *   GET  /api/editor/settlements/rules   → { ok, content, missing }  (the built-in rules when no file exists)
 *   PUT  /api/editor/settlements/rules   → { content }: checkRules, then write; 400 with per-path issues writes nothing
 *   POST /api/editor/settlements/preview → { content, population, seed, land }: build one town from the
 *                                          candidate rules (nothing written) and sum it up, with its plan
 *
 * The path is fixed, never taken from the request.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { BUILTIN_RULES, checkRules, type GenerationResult, type Land, type SettlementRequest } from "@mmo-engine/settlement";
import { failureReply, jsonBodyField, refuseInvalid, type RouteReply } from "./api.js";
import type { LandPreset, SettlementPreview } from "./settlement-preview.js";

export const settlementRulesFile = (repoRoot: string): string => resolve(repoRoot, "content", "settlements", "rules.json");

/** The rules file's content, or the built-in rules when there is none. */
export function readSettlementRules(repoRoot: string): { content: unknown; missing: boolean } {
  const file = settlementRulesFile(repoRoot);
  if (!existsSync(file)) return { content: BUILTIN_RULES, missing: true };
  try {
    return { content: JSON.parse(readFileSync(file, "utf8")) as unknown, missing: false };
  } catch (e) {
    throw Object.assign(new Error(`settlements/rules.json: ${(e as Error).message}`), { status: 500 });
  }
}

/** A problem as the Rules panel shows it (file, path, message). */
const issuesOf = (content: unknown) => checkRules(content).map((i) => ({ file: "settlements/rules.json", path: i.path, message: i.message }));

/** Check `content`, then write it pretty-printed. Throws { status: 400, issues } and writes nothing when invalid. */
export function saveSettlementRules(repoRoot: string, content: unknown): void {
  const issues = issuesOf(content);
  if (issues.length > 0) throw refuseInvalid("town rules", issues);
  const file = settlementRulesFile(repoRoot);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/** The land a preview town stands on: what each preset gives its industry to read. */
export const LAND_PRESETS: Record<LandPreset, Land | undefined> = {
  none: undefined,
  forest: { biomes: { forest: 650, plains: 350 }, waterKind: "none", shoreM: -1 },
  mountains: { biomes: { mountains: 450, plains: 400, forest: 150 }, waterKind: "none", shoreM: -1 },
  coast: { biomes: { sea: 400, beach: 100, plains: 300, forest: 200 }, waterKind: "sea", shoreM: 20 },
  farmland: { biomes: { plains: 1000 }, waterKind: "none", shoreM: -1 },
};

const count = <T>(items: readonly T[], key: (t: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const t of items) out[key(t)] = (out[key(t)] ?? 0) + 1;
  return out;
};

/** A preview town that takes longer than this is given up on. */
const PREVIEW_TIMEOUT_MS = 120_000;

/**
 * Generate on a worker thread: a big town can take a minute to solve, and the dev host serves every other panel
 * from this thread meanwhile.
 */
function generateOffThread(request: SettlementRequest): Promise<GenerationResult> {
  const entry = import.meta.resolve("@mmo-engine/settlement");
  const code = `const { parentPort, workerData } = require("node:worker_threads");
import(${JSON.stringify(entry)}).then((m) => parentPort.postMessage(m.generateSettlement(workerData)));`;
  return new Promise((done, fail) => {
    const worker = new Worker(code, { eval: true, workerData: request });
    const timer = setTimeout(() => {
      void worker.terminate();
      fail(new Error(`the town took longer than ${PREVIEW_TIMEOUT_MS / 1000} s to build; try fewer people`));
    }, PREVIEW_TIMEOUT_MS);
    worker.once("message", (r: GenerationResult) => {
      clearTimeout(timer);
      void worker.terminate();
      done(r);
    });
    worker.once("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
  });
}

/** Build one town from candidate rules (nothing written) and sum it up. Invalid rules come back as issues, not a town. */
export async function previewSettlement(content: unknown, population: number, seed: number, land: LandPreset): Promise<SettlementPreview> {
  const issues = issuesOf(content);
  if (issues.length > 0) return { ok: false, issues };
  if (!Number.isInteger(population) || population < 1 || population > 20000) return { ok: false, error: "population must be a whole number from 1 to 20000" };
  const preset = LAND_PRESETS[land];
  let r: GenerationResult;
  try {
    r = await generateOffThread({ settlementId: "preview", seed: seed >>> 0, population, rules: content as SettlementRequest["rules"], access: "road", ...(preset ? { land: preset } : {}) });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!r.ok) return { ok: false, error: `${r.error.stage}: ${r.error.message}` };
  const m = r.manifest;
  const resources = Object.entries(count(m.resources, (n) => `${n.kind}|${n.material}|${n.tier}`)).map(([k, nodes]) => {
    const [kind, material, tier] = k.split("|");
    return { kind: kind!, material: material!, tier: Number(tier), nodes, stock: m.resources.filter((n) => `${n.kind}|${n.material}|${n.tier}` === k).reduce((a, n) => a + n.stock, 0) };
  });
  return {
    ok: true,
    rulesVersion: m.rulesVersion,
    population: m.setting.population,
    households: m.demographics.households,
    homeless: m.demographics.homeless,
    walled: m.walled,
    structures: m.structures.length,
    archetypes: Object.entries(count(m.structures, (s) => s.archetype)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    industry: m.industry?.primary ? { primary: m.industry.primary, workplace: m.industry.workplace, product: m.industry.product } : null,
    guild: m.guild ? { profession: m.guild.profession, hasHall: m.guild.hall !== null, ranks: m.guild.ranks.map((g) => g.title) } : null,
    resources,
    gates: { total: m.validation.length, failed: m.validation.filter((g) => !g.ok).map((g) => g.gate) },
    plan: {
      parcels: m.parcels.map((p) => ({ x: p.center.x / 1000, z: p.center.z / 1000, side: Math.sqrt(p.areaM2), kind: p.kind })),
      resources: m.resources.map((n) => ({ x: n.center.x / 1000, z: n.center.z / 1000, kind: n.kind })),
    },
  };
}

const PRESETS = Object.keys(LAND_PRESETS) as LandPreset[];

function previewBody(body: string | undefined): { content: unknown; population: number; seed: number; land: LandPreset } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? "") as unknown;
  } catch {
    throw Object.assign(new Error("request body is not valid JSON"), { status: 400 });
  }
  const b = (parsed ?? {}) as Record<string, unknown>;
  const land = (b.land ?? "none") as LandPreset;
  if (!("content" in b) || typeof b.population !== "number" || typeof b.seed !== "number" || !PRESETS.includes(land)) {
    throw Object.assign(new Error(`need {"content", "population", "seed", "land": ${PRESETS.join("|")}}`), { status: 400 });
  }
  return { content: b.content, population: b.population, seed: b.seed, land };
}

export async function handleSettlementRoute(repoRoot: string, method: string, pathname: string, body: string | undefined): Promise<RouteReply | null> {
  if (!pathname.startsWith("/api/editor/settlements/")) return null;
  try {
    if (pathname === "/api/editor/settlements/rules" && method === "GET") return { status: 200, body: { ok: true, ...readSettlementRules(repoRoot) } };
    if (pathname === "/api/editor/settlements/rules" && method === "PUT") {
      saveSettlementRules(repoRoot, jsonBodyField(body, "content"));
      return { status: 200, body: { ok: true } };
    }
    if (pathname === "/api/editor/settlements/preview" && method === "POST") {
      const p = previewBody(body);
      return { status: 200, body: await previewSettlement(p.content, p.population, p.seed, p.land) };
    }
    return { status: 404, body: { ok: false, error: "not found" } };
  } catch (err) {
    return failureReply(err);
  }
}
