/**
 * View-side data contracts for the editor dashboard (read-only direction).
 *
 * Every center view declares what backend data it expects, where the
 * controller fetches it, and whether that source is live today. The types
 * here are VIEW-SIDE MIRRORS — each carries a `Source:` note pointing at
 * the authoritative backend model. Never import engine-core here (the
 * editor depends on protocol + mirror only); when a protocol type already
 * exists it is re-exported instead of redefined.
 *
 * Status vocabulary:
 * - "live"   — consumable today (mirror state, typed wire message, HTTP).
 * - "parsed" — consumable today by parsing a text admin result (provisional;
 *              a future `--json` gateway flag retires the parser, views stay).
 * - "staged" — names the owning endpoint/slice; the view shows sample data
 *              and an honest badge until the backend exposes it.
 * - "local"  — content-file data with no backend model (local drafts are
 *              the honest state; see the scenes-slice rule for flow).
 */

export type DataStatus = "live" | "parsed" | "staged" | "local";

/** `workspace/view` key, same shape as the deep-link registry. */
export type ViewKey =
  | "world/terrain"
  | "scene/ecs"
  | "flow/flow"
  | "flow/hud"
  | "characters/records"
  | "gameplay/tables"
  | "gameplay/rules"
  | "dungeons/dungeons"
  | "dungeons/graphs"
  | "liveops/overview"
  | "network/network"
  | "debug/play"
  | "database/grid"
  | "database/query"
  | "story/quests"
  | "story/strings"
  | "artaudio/assets"
  | "artaudio/animation"
  | "artaudio/vfx"
  | "artaudio/audio"
  | "release/pipeline"
  | "release/playtests";

export interface ViewDataBinding {
  view: ViewKey;
  /** Human label for badges and docs. */
  label: string;
  /** Expected payload type name (defined below or in @mmo-engine/protocol). */
  expects: string;
  /** Controller path: mirror state, admin verb, debug query, HTTP route… */
  via: string;
  status: DataStatus;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Live-ops models (mirrors of engine-core; see net/gateway.ts, stats/*)
// ---------------------------------------------------------------------------

/** Source: engine `stats/telemetry.ts` TelemetrySnapshot via admin `stats`
 *  (message is JSON.stringify of the snapshot — parse, don't scrape). */
export interface TelemetrySnapshot {
  bucketSeconds: number;
  buckets: number;
  series: Record<string, number[]>;
  totals: Record<string, number>;
  tick: { count: number; p50Ms: number; p99Ms: number; maxMs: number };
}

export function parseTelemetrySnapshot(message: string): TelemetrySnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message) as unknown;
  } catch {
    throw new Error("backend: stats returned non-JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { bucketSeconds?: unknown }).bucketSeconds !== "number" ||
    typeof (parsed as { buckets?: unknown }).buckets !== "number" ||
    typeof (parsed as { series?: unknown }).series !== "object" ||
    (parsed as { series?: unknown }).series === null ||
    typeof (parsed as { totals?: unknown }).totals !== "object" ||
    (parsed as { totals?: unknown }).totals === null ||
    typeof (parsed as { tick?: unknown }).tick !== "object" ||
    (parsed as { tick?: unknown }).tick === null
  ) {
    throw new Error("backend: stats snapshot missing bucketSeconds/buckets/series/totals/tick");
  }
  const tick = (parsed as { tick: Record<string, unknown> }).tick;
  for (const k of ["count", "p50Ms", "p99Ms", "maxMs"]) {
    if (typeof tick[k] !== "number") throw new Error(`backend: stats tick.${k} is not a number`);
  }
  return parsed as TelemetrySnapshot;
}

/** Source: engine `net/gateway.ts` ClientSession (no wire dump yet —
 *  expect a future dev-host `GET /api/editor/sessions`). */
export interface SessionRosterEntry {
  username: string;
  playerEntity: string | null;
  character: { id: number; name: string } | null;
  lastAckedTick: number;
  missedHeartbeats: number;
  isAdmin: boolean;
}

/** Source: engine `net/gateway.ts:409` AdminLogEntry (in-memory ring 200 —
 *  expect a future dev-host `GET /api/editor/admin-log`). */
export interface AdminLogEntry {
  at: number;
  username: string;
  command: string;
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Entity inspector model (mirrors engine admin/inspect.ts dump format)
// ---------------------------------------------------------------------------

/** Source: engine `admin/inspect.ts inspectEntity()` text dump, parsed.
 *  Provisional by design: line formats are exact today (see parser), but
 *  a future `inspect --json` retires this without touching views. Unknown
 *  component lines land in `extra` so new components never break views. */
export interface InspectEntity {
  wireId: string;
  slot: number;
  transform?: { pos: [number, number, number]; rot: [number, number, number, number] };
  velocity?: { lin: [number, number, number] };
  intent?: { move: [number, number, number]; lookYaw: number; lookPitch: number; jump: number; buttons: number };
  chunk?: { id: string; lod: number };
  health?: { current: number; max: number };
  body?: { shape: number; motion: number; mass: number };
  pathRequest?: { x: number; z: number; profile: number; token: number };
  pathState?: { status: string; token: number; waypoints: number };
  navAgent?: { target: [number, number, number]; state: number };
  asset?: { hash: number; variant: number };
  locomotion?: { mode: number; abilities: number; breath: number };
  appearance?: { look: unknown };
  action?: { move: number; started: number; seq: number };
  stats?: Record<string, number>;
  extra: Record<string, string>;
}

function num(tok: string | undefined): number | null {
  if (tok === undefined) return null;
  const v = Number(tok);
  return Number.isFinite(v) ? v : null;
}

function triple(toks: string[], i: number): [number, number, number] | null {
  const a = num(toks[i]);
  const b = num(toks[i + 1]);
  const c = num(toks[i + 2]);
  return a === null || b === null || c === null ? null : [a, b, c];
}

export function parseInspectEntity(dump: string): InspectEntity {
  const lines = dump.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const head = lines.length > 0 ? lines[0].match(/^entity (\S+) \(slot (\d+)\)$/) : null;
  if (!head) throw new Error("backend: inspect dump missing `entity <wire> (slot <eid>)` header");
  const out: InspectEntity = { wireId: head[1], slot: Number(head[2]), extra: {} };
  for (const line of lines.slice(1)) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (!m) {
      out.extra[line] = "";
      continue;
    }
    const name = m[1].trim();
    const rest = m[2].trim();
    const t = rest.split(/\s+/);
    const after = (word: string): string[] => {
      const i = t.indexOf(word);
      return i < 0 ? [] : t.slice(i + 1);
    };
    switch (name) {
      case "Transform": {
        const pos = triple(after("pos"), 0);
        const rq = after("rot").slice(0, 4).map((s) => num(s));
        if (pos && rq.length === 4 && rq.every((v) => v !== null)) {
          out.transform = { pos, rot: rq as [number, number, number, number] };
        } else out.extra[name] = rest;
        break;
      }
      case "Velocity": {
        const lin = triple(after("lin"), 0);
        if (lin) out.velocity = { lin };
        else out.extra[name] = rest;
        break;
      }
      case "PlayerIntent": {
        const move = triple(after("move"), 0);
        const lookYaw = num(after("look")[0]);
        const lookPitch = num(after("look")[1]);
        const jump = num(after("jump")[0]);
        const buttons = num(after("buttons")[0]);
        if (move && lookYaw !== null && lookPitch !== null && jump !== null && buttons !== null) {
          out.intent = { move, lookYaw, lookPitch, jump, buttons };
        } else out.extra[name] = rest;
        break;
      }
      case "Chunk": {
        const id = after("id")[0];
        const lod = num(after("lod")[0]);
        if (id !== undefined && lod !== null) out.chunk = { id, lod };
        else out.extra[name] = rest;
        break;
      }
      case "Health": {
        const parts = rest.split("/");
        const cur = num(parts[0]);
        const max = num(parts[1]);
        if (cur !== null && max !== null) out.health = { current: cur, max };
        else out.extra[name] = rest;
        break;
      }
      case "BodyConfig": {
        const shape = num(after("shape")[0]);
        const motion = num(after("motion")[0]);
        const mass = num(after("mass")[0]);
        if (shape !== null && motion !== null && mass !== null) out.body = { shape, motion, mass };
        else out.extra[name] = rest;
        break;
      }
      case "PathRequest": {
        const to = after("to");
        const x = num(to[0]);
        const z = num(to[1]);
        const profile = num(after("profile")[0]);
        const token = num(after("token")[0]);
        if (x !== null && z !== null && profile !== null && token !== null) {
          out.pathRequest = { x, z, profile, token };
        } else out.extra[name] = rest;
        break;
      }
      case "PathState": {
        const status = after("status")[0];
        const token = num(after("token")[0]);
        const waypoints = num(after("waypoints")[0]);
        if (status !== undefined && token !== null && waypoints !== null) {
          out.pathState = { status, token, waypoints };
        } else out.extra[name] = rest;
        break;
      }
      case "NavAgent": {
        const target = triple(after("target"), 0);
        const state = num(after("state")[0]);
        if (target && state !== null) out.navAgent = { target, state };
        else out.extra[name] = rest;
        break;
      }
      case "AssetRef": {
        const hash = num(after("hash")[0]);
        const variant = num(after("variant")[0]);
        if (hash !== null && variant !== null) out.asset = { hash, variant };
        else out.extra[name] = rest;
        break;
      }
      case "Locomotion": {
        const mode = num(after("mode")[0]);
        const abilities = num(after("abilities")[0]);
        const breath = num(after("breath")[0]);
        if (mode !== null && abilities !== null && breath !== null) {
          out.locomotion = { mode, abilities, breath };
        } else out.extra[name] = rest;
        break;
      }
      case "Appearance": {
        try {
          out.appearance = { look: JSON.parse(rest) as unknown };
        } catch {
          out.extra[name] = rest;
        }
        break;
      }
      case "Action": {
        const move = num(after("move")[0]);
        const started = num(after("started")[0]);
        const seq = num(after("seq")[0]);
        if (move !== null && started !== null && seq !== null) out.action = { move, started, seq };
        else out.extra[name] = rest;
        break;
      }
      case "Stats": {
        const stats: Record<string, number> = {};
        let ok = false;
        for (const tok of t) {
          const kv = tok.match(/^([^=]+)=(-?\d+(?:\.\d+)?)$/);
          if (kv) {
            stats[kv[1]] = Number(kv[2]);
            ok = true;
          }
        }
        if (ok) out.stats = stats;
        else out.extra[name] = rest;
        break;
      }
      default:
        out.extra[name] = rest;
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Database + content models (mirrors of SQLite tables and content docs)
// ---------------------------------------------------------------------------

/** Source: any `*.db` table via a future dev-host
 *  `GET /api/editor/tables?db=&table=` (SQLite files are not
 *  browser-readable; precedent: `/api/editor/pcg/*`). */
export interface TablePage {
  db: string;
  table: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  explain?: string[];
}

/** Source: engine `characters/character-view.ts` CharacterView via a
 *  future dev-host `GET /api/editor/characters/:name`. */
export interface CharacterDossier {
  id: number;
  username: string;
  name: string;
  createdAt: string;
  lookJson: string;
  deaths: Array<{ at: string; x: number; z: number; killer: number | null }>;
  state: { x: number; y: number; z: number; health: number; stamina: number } | null;
  items: Array<{ id: number; where: string; slot: number; def: string; name: string; durability: number }>;
}

/** Source: engine `quests/quest-def.ts` QuestDef + `quests/quest-log.ts`
 *  QuestRecord (`quests.db quest_log.record` JSON) via future dev-host
 *  quest endpoints. Live per-session state already rides wire `0x11`
 *  QuestView — see @mmo-engine/protocol. */
export interface QuestDefView {
  id: string;
  name: string;
  giver: string;
  summary: string;
  steps: Array<{ id: string; text: string; objective: unknown }>;
  rewards: Array<{ base: string; count: number }>;
  repeatable: boolean;
}

export interface QuestRecordView {
  questId: string;
  state: "active" | "done";
  step: number;
  progress: number;
}

/** Source: engine `items/item-defs.ts` ItemDefs via a future dev-host
 *  catalog endpoint (admin `items` covers live lookup only). */
export interface ItemDefView {
  id: number;
  name: string;
  base: string;
  rank: string;
  color: string;
  stats: Record<string, number>;
  model: string;
}

/** Source: release tooling (no backend model) — local playtest records. */
export interface ScenarioResult {
  scenario: string;
  step: string;
  ok: boolean;
  detail: string;
}

/** Source: edge split (§7c) — no backend model yet. */
export interface RouteHealth {
  route: string;
  kind: "core" | "local";
  ok: boolean;
  latencyMs: number | null;
}

/** Source: content files (`content/scenes/*.flow.json`,
 *  `content/ui/hud.json`, locale files, art clips) — no backend model;
 *  local drafts are the honest state. */
export interface ContentDoc {
  path: string;
  kind: "flow" | "hud" | "strings" | "anim" | "vfx" | "audio" | "rules" | "pipeline" | "scenario";
}

// ---------------------------------------------------------------------------
// Per-view registry: every center view declares its expected backend data
// ---------------------------------------------------------------------------

export const VIEW_DATA_CONTRACT: Record<ViewKey, ViewDataBinding> = {
  "world/terrain": {
    view: "world/terrain",
    label: "World viewport",
    expects: "WelcomeMessage.world + ChunkRow[] + TerrainTile (terrain_tiles)",
    via: "mirror: onWelcome world/day + snapshots; http:/api/editor/terrain (staged)",
    status: "live",
    notes: "WorldInfo/bounds/day clock and chunk heights are live; baked-tile inspection awaits a terrain endpoint.",
  },
  "scene/ecs": {
    view: "scene/ecs",
    label: "Scene viewport + ECS inspector",
    expects: "EntityMirror (all CollectedState rows)",
    via: "mirror: MirrorState.entities",
    status: "live",
  },
  "flow/flow": {
    view: "flow/flow",
    label: "Screen flow graph",
    expects: "ContentDoc(flow)",
    via: "content: content/scenes/login-to-world.flow.json",
    status: "local",
    notes: "No scenes-slice model exists; node/edge/bend drafts are local until it lands.",
  },
  "flow/hud": {
    view: "flow/hud",
    label: "HUD layout",
    expects: "ContentDoc(hud)",
    via: "content: content/ui/hud.json",
    status: "local",
  },
  "characters/records": {
    view: "characters/records",
    label: "Character records",
    expects: "CharacterDossier[]",
    via: "http:/api/editor/characters",
    status: "staged",
    notes: "Engine read model exists (character-view.ts); needs the HTTP exposure.",
  },
  "gameplay/tables": {
    view: "gameplay/tables",
    label: "Gameplay tables",
    expects: "StatsMessage live values + TablePage",
    via: "mirror: onStats; http:/api/editor/tables (staged)",
    status: "live",
    notes: "Live stat lines are typed wire data; persisted table rows await the tables endpoint.",
  },
  "gameplay/rules": {
    view: "gameplay/rules",
    label: "Gameplay rules",
    expects: "ContentDoc(rules)",
    via: "content: rules documents",
    status: "local",
  },
  "dungeons/dungeons": {
    view: "dungeons/dungeons",
    label: "Dungeon instances",
    expects: "DungeonEntranceView[] + DungeonMessage state",
    via: "mirror: onDungeon + admin:spawn",
    status: "live",
  },
  "dungeons/graphs": {
    view: "dungeons/graphs",
    label: "PICG graph editor",
    expects: "GraphDocument (inspectors/graph-editor.ts)",
    via: "http:/api/editor/pcg/*",
    status: "live",
  },
  "liveops/overview": {
    view: "liveops/overview",
    label: "Live-ops overview",
    expects: "TelemetrySnapshot + SessionRosterEntry[] + AdminLogEntry[]",
    via: "admin:stats (parsed) + http:/api/editor/sessions + http:/api/editor/admin-log (staged)",
    status: "parsed",
    notes: "Telemetry parses from stats JSON today; roster and audit log need new reads.",
  },
  "network/network": {
    view: "network/network",
    label: "Edge routes",
    expects: "RouteHealth[]",
    via: "none (edge split §7c not implemented)",
    status: "staged",
  },
  "debug/play": {
    view: "debug/play",
    label: "Play mode",
    expects: "DebugResponse + InspectEntity + EntityMirror + AdminResult verbs",
    via: "mirror: debug() 0x0a; admin: inspect/set/spawn/teleport/heal",
    status: "live",
  },
  "database/grid": {
    view: "database/grid",
    label: "Data grid",
    expects: "TablePage",
    via: "http:/api/editor/tables",
    status: "staged",
    notes: "Covers characters/character_state/deaths, item_events, chunk_entities, quest_log, sessions, guilds, parties, friends.",
  },
  "database/query": {
    view: "database/query",
    label: "Query + plan",
    expects: "TablePage + explain[]",
    via: "http:/api/editor/query",
    status: "staged",
  },
  "story/quests": {
    view: "story/quests",
    label: "Quest graph",
    expects: "QuestDefView[] + QuestRecordView[] (+ wire QuestView live)",
    via: "http:/api/editor/quests (staged); mirror: onQuests (live)",
    status: "staged",
    notes: "Live per-session quest state is typed wire data; defs/records need HTTP reads.",
  },
  "story/strings": {
    view: "story/strings",
    label: "String table",
    expects: "ContentDoc(strings)",
    via: "content: locale files",
    status: "local",
  },
  "artaudio/assets": {
    view: "artaudio/assets",
    label: "Art assets",
    expects: "ItemDefView[] + art manifest",
    via: "http:/api/editor/catalog (staged); admin:items (live lookup)",
    status: "staged",
  },
  "artaudio/animation": {
    view: "artaudio/animation",
    label: "Animation clips",
    expects: "ContentDoc(anim)",
    via: "content: art clips",
    status: "local",
  },
  "artaudio/vfx": {
    view: "artaudio/vfx",
    label: "VFX",
    expects: "ContentDoc(vfx)",
    via: "content: vfx docs",
    status: "local",
  },
  "artaudio/audio": {
    view: "artaudio/audio",
    label: "Audio events",
    expects: "ContentDoc(audio)",
    via: "content: audio events",
    status: "local",
  },
  "release/pipeline": {
    view: "release/pipeline",
    label: "Release pipeline",
    expects: "ContentDoc(pipeline)",
    via: "content: pipeline docs",
    status: "local",
  },
  "release/playtests": {
    view: "release/playtests",
    label: "Playtests",
    expects: "ScenarioResult[]",
    via: "local: release tooling records",
    status: "local",
  },
};

/** Atomic backend sources. The coverage test requires every one to be
 *  referenced (as a substring of `expects` or `via`) by at least one
 *  registry entry — no backend data without a view. */
export const BACKEND_SOURCES: readonly string[] = [
  "MirrorState.entities",
  "WelcomeMessage",
  "ChunkRow",
  "StatsMessage",
  "DungeonEntranceView",
  "DungeonMessage",
  "GraphDocument",
  "QuestView",
  "DebugResponse",
  "AdminResult",
  "TelemetrySnapshot",
  "SessionRosterEntry",
  "AdminLogEntry",
  "TablePage",
  "CharacterDossier",
  "QuestDefView",
  "QuestRecordView",
  "ItemDefView",
  "ScenarioResult",
  "RouteHealth",
  "ContentDoc",
  "TerrainTile",
  "InspectEntity",
];

/** View keys in registry order (stable for tests and docs). */
export const VIEW_KEYS: readonly ViewKey[] = Object.keys(VIEW_DATA_CONTRACT) as ViewKey[];
