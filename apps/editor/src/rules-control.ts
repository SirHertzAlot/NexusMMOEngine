/**
 * Browser-safe side of the gameplay tables (roadmap ED1): the HTTP
 * adapter over the dev host's /api/editor/tables routes, and the field
 * specs and pure helpers the Rules panel edits with.
 *
 * Split from rules-store.ts for the same reason as server-control.ts:
 * that one reads the filesystem (Node-only), this one only fetches.
 */

export const TABLES = ["items", "creatures", "loot", "death", "ingress", "gathering"] as const;
export type Table = (typeof TABLES)[number];

/** One validation problem, as the rules package reports it. */
export interface RulesIssue {
  file: string;
  path: string;
  message: string;
}

export interface RulesSnapshot {
  tables: Record<Table, unknown>;
  techniques: string[];
}

export type SaveResult = { ok: true } | { ok: false; issues: RulesIssue[] };

export interface RulesControl {
  load(): Promise<RulesSnapshot>;
  save(table: Table, json: unknown): Promise<SaveResult>;
}

export function createRulesControl(base = ""): RulesControl {
  return {
    async load() {
      const res = await fetch(`${base}/api/editor/tables`);
      const body = (await res.json()) as RulesSnapshot & { ok: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `load failed: HTTP ${res.status}`);
      return { tables: body.tables, techniques: body.techniques };
    },
    async save(table, json) {
      const res = await fetch(`${base}/api/editor/tables`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: table, json }),
      });
      const body = (await res.json()) as SaveResult & { error?: string };
      if (res.status === 422 && !body.ok) return body;
      if (!res.ok || !body.ok) throw new Error(body.error ?? `save failed: HTTP ${res.status}`);
      return { ok: true };
    },
  };
}

// ------------------------------------------------------------ field specs

export type FieldKind =
  | { kind: "number"; int?: boolean; min?: number; max?: number }
  | { kind: "bool" }
  | { kind: "enum"; options: readonly string[] | "techniques" }
  | { kind: "text" }
  /** Comma-separated strings. */
  | { kind: "list" }
  /** Two integers, "min–max". */
  | { kind: "pair" };

export type FieldSpec = FieldKind & {
  /** Key path inside the entry (or the table, for flat tables). */
  key: string;
  label: string;
  /** The engine default an absent key takes (shown as the placeholder). */
  def?: unknown;
  /** Read once at server start: a running server needs a restart. */
  restart?: boolean;
};

const share = { kind: "number", min: 0, max: 1 } as const;

/** One item base's fields (items.json bases.<id>, fallback, unarmed). */
export const ITEM_BASE_FIELDS: FieldSpec[] = [
  { key: "mass", label: "Mass (kg)", kind: "number", min: 0, def: 1 },
  { key: "length", label: "Reach (m)", kind: "number", min: 0, def: 0.5 },
  { key: "edge", label: "Edge", ...share, def: 0.1 },
  { key: "point", label: "Point", ...share, def: 0.1 },
  { key: "hardness", label: "Hardness", ...share, def: 0.5 },
  { key: "balance", label: "Balance", ...share, def: 0.5 },
  { key: "durability", label: "Durability", kind: "number", int: true, min: 1, def: 100 },
  { key: "hand", label: "Hand", kind: "enum", options: ["main", "off", "both", "none"], def: "none" },
  { key: "technique", label: "Technique", kind: "enum", options: "techniques", def: "bludgeon" },
  { key: "models", label: "Models", kind: "list", def: [] },
];

/** items.json's own fields, beside its bases. */
export const ITEMS_FIELDS: FieldSpec[] = [{ key: "powerScale", label: "Power scale", kind: "number", min: 0, def: 0.02 }];

/** One creature kind's fields (creatures.json creatures.<id>). */
export const CREATURE_FIELDS: FieldSpec[] = [
  { key: "name", label: "Name", kind: "text" },
  { key: "model", label: "Model (asset ID)", kind: "text", def: "" },
  { key: "health", label: "Health", kind: "number", min: 0 },
  { key: "aggroRadius", label: "Aggro radius (m)", kind: "number", min: 0 },
  { key: "leashRadius", label: "Leash radius (m)", kind: "number", min: 0 },
  { key: "respawnSeconds", label: "Respawn (s)", kind: "number", min: 0 },
  { key: "pack", label: "Pack size", kind: "pair", def: [1, 1] },
  { key: "weapons", label: "Weapons (item bases)", kind: "list" },
  { key: "chaseSpeed", label: "Chase speed (share)", ...share, def: 0.9 },
  { key: "attackEverySeconds", label: "Attack every (s)", kind: "number", min: 0, def: 1.5 },
];

export const LOOT_FIELDS: FieldSpec[] = [
  { key: "ownershipSeconds", label: "Ownership (s)", kind: "number", min: 0, def: 30 },
  { key: "despawnSeconds", label: "Despawn (s)", kind: "number", min: 0, def: 300 },
  { key: "pickupRange", label: "Pickup range (m)", kind: "number", min: 0, def: 2.5 },
  { key: "bagSlots", label: "Bag slots", kind: "number", int: true, min: 1, max: 256, def: 24, restart: true },
  { key: "maxGroundItems", label: "Max ground items", kind: "number", int: true, min: 1, max: 65536, def: 4096 },
];

export const DEATH_FIELDS: FieldSpec[] = [
  { key: "respawn.delaySeconds", label: "Respawn delay (s)", kind: "number", min: 0, def: 10 },
  { key: "respawn.at", label: "Respawn at", kind: "enum", options: ["spawn", "nearestVisited"], def: "spawn" },
  { key: "keep.skills", label: "Keep skills", kind: "bool", def: true },
  { key: "keep.items", label: "Items on death", kind: "enum", options: ["keep", "drop", "partial"], def: "keep" },
  { key: "keep.partialLoss", label: "Partial loss (share)", ...share, def: 0.25 },
  { key: "keep.injuries", label: "Keep injuries", kind: "bool", def: false },
  { key: "recordDeaths", label: "Record deaths", kind: "bool", def: true },
];

/** A new entry's starting values: every field's default, plus the required ones. */
export function newEntry(table: "items" | "creatures", bases: string[]): Record<string, unknown> {
  if (table === "items") return { mass: 1, length: 0.5, durability: 100, hand: "main", technique: "bludgeon", models: [] };
  return {
    name: "New creature",
    health: 50,
    aggroRadius: 10,
    leashRadius: 25,
    respawnSeconds: 60,
    pack: [1, 1],
    weapons: bases.length > 0 ? [bases[0]] : [],
  };
}

/** gathering.json's fields (resource nodes; each node's own stock and regrow time are its scene's ResourceNode). */
export const GATHERING_FIELDS: FieldSpec[] = [
  { key: "reachM", label: "Reach from a node's edge (m)", kind: "number", min: 0, def: 2.5 },
  { key: "cooldownSeconds", label: "One gather every (s)", kind: "number", min: 0, def: 1.2 },
  { key: "pouchMax", label: "Pouch holds of a material", kind: "number", int: true, min: 1, def: 999 },
  { key: "trainDifficultyPerTier", label: "Training difficulty per tier", ...share, def: 0.2 },
];

/** ingress.json's fields (roadmap T1 rate limits). */
export const INGRESS_FIELDS: FieldSpec[] = [
  { key: "maxClientPayloadBytes", label: "Max frame (bytes)", kind: "number", int: true, min: 1, def: 65536, restart: true },
  { key: "intentsPerSecond", label: "Intents / second", kind: "number", min: 1, def: 40 },
  { key: "intentBurst", label: "Intent burst", kind: "number", int: true, min: 1, def: 60 },
  { key: "pickupsPerSecond", label: "Pickups / second", kind: "number", min: 1, def: 5 },
  { key: "pickupBurst", label: "Pickup burst", kind: "number", int: true, min: 1, def: 10 },
  { key: "abuseWindowSeconds", label: "Abuse window (s)", kind: "number", min: 1, def: 10 },
  { key: "maxViolations", label: "Violations to disconnect", kind: "number", int: true, min: 1, def: 100 },
];

// ---------------------------------------------------------------- helpers

/** `a.b.c` → ["a","b","c"]. */
function keys(path: string): string[] {
  return path === "" ? [] : path.split(".");
}

export function getAt(obj: unknown, path: string): unknown {
  let at: unknown = obj;
  for (const k of keys(path)) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[k];
  }
  return at;
}

/**
 * `obj` with `path` set to `value` (copied along the path; the rest
 * shared). `undefined` removes the key — the engine default applies.
 */
export function setAt<T>(obj: T, path: string, value: unknown): T {
  const ks = keys(path);
  if (ks.length === 0) return value as T;
  const [head, ...rest] = ks;
  const src = obj !== null && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...src };
  const next = rest.length === 0 ? value : setAt(src[head], rest.join("."), value);
  if (next === undefined) delete out[head];
  else out[head] = next;
  return out as T;
}

/** A field's value as the text its input shows ("" when absent). */
export function fieldText(spec: FieldSpec, value: unknown): string {
  if (value === undefined) return "";
  if (spec.kind === "list" || spec.kind === "pair") return Array.isArray(value) ? value.join(spec.kind === "pair" ? "–" : ", ") : "";
  return String(value);
}

/**
 * Text from a field's input as the JSON value to store: `undefined`
 * for an empty input (back to the default), or `{ error }` when the
 * text can't be the field's kind. Ranges are left to the server's
 * validation, which reports them with the field.
 */
export function parseField(spec: FieldSpec, text: string): unknown {
  const t = text.trim();
  if (t === "") return undefined;
  switch (spec.kind) {
    case "number": {
      const n = Number(t);
      if (!Number.isFinite(n)) return { error: "not a number" };
      return n;
    }
    case "bool":
      return t === "true";
    case "list":
      return t
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    case "pair": {
      const parts = t.split(/[-–,\s]+/).filter((s) => s !== "");
      const ns = parts.map(Number);
      if (ns.length !== 2 || !ns.every(Number.isInteger)) return { error: "two whole numbers, e.g. 2–4" };
      return ns;
    }
    default:
      return t;
  }
}

export function isFieldError(v: unknown): v is { error: string } {
  return v !== null && typeof v === "object" && !Array.isArray(v) && typeof (v as { error?: unknown }).error === "string";
}

/** Issues for `table`'s file under `path` (the path itself, or a key or index below it). */
export function issuesAt(issues: readonly RulesIssue[], table: Table, path: string): RulesIssue[] {
  const file = `${table}.json`;
  return issues.filter(
    (i) => i.file === file && (i.path === path || i.path.startsWith(`${path}.`) || i.path.startsWith(`${path}[`)),
  );
}
