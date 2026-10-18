/**
 * Browser-safe side of the gameplay tables (roadmap ED1): the HTTP
 * adapter over the dev host's /api/editor/tables routes, and the field
 * specs and pure helpers the Rules panel edits with.
 *
 * Split from rules-store.ts for the same reason as server-control.ts:
 * that one reads the filesystem (Node-only), this one only fetches.
 */

export const TABLES = ["items", "creatures", "combat", "body", "loot", "death", "ingress", "gathering"] as const;
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
  /** skills.json's skill ids (with defaults), for a technique's skill. */
  skills: string[];
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
      return { tables: body.tables, techniques: body.techniques, skills: body.skills ?? [] };
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
  /** `options` as a string names a list the form is given (`"techniques"`). */
  | { kind: "enum"; options: readonly string[] | string }
  | { kind: "text" }
  /** Comma-separated strings. */
  | { kind: "list" }
  /** Two integers, "min–max". */
  | { kind: "pair" }
  /** Id to number, "legLeft: 0.35, hips: 0.15". */
  | { kind: "map" };

export type FieldSpec = FieldKind & {
  /** Key path inside the entry (or the table, for flat tables). */
  key: string;
  label: string;
  /** The engine default an absent key takes (shown as the placeholder). */
  def?: unknown;
  /** Read once at server start: a running server needs a restart. */
  restart?: boolean;
  /** One line a designer reads under the field: what it does, in game terms. */
  help?: string;
  /** An empty input stores null (the schema's "none") instead of removing the key. */
  nullable?: boolean;
  /** The key may be absent with no default (empty reads "none", not "required"). */
  optional?: boolean;
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

/** A titled group of fields with a line of help: one section of a long form. */
export interface FieldSectionSpec {
  title: string;
  help: string;
  fields: FieldSpec[];
}

/** One technique (combat.json techniques.<id>). */
export const TECHNIQUE_FIELDS: FieldSpec[] = [
  { key: "property", label: "Reads the item's", kind: "enum", options: ["edge", "point", "hardness"], help: "The item property that makes this technique fit a weapon." },
  { key: "damageKind", label: "Damage kind", kind: "enum", options: ["cut", "blunt", "thrust"], help: "Decides bleeding, maiming and dismembering (Body › Severity)." },
  { key: "skill", label: "Skill", kind: "enum", options: "skills", help: "The skill that trains and powers it. Empty: none." },
];

/** combat.json beside its techniques (docs/MASTERY-AND-COMBAT.md). m is the attacker's mastery, 0 to 1. */
export const COMBAT_SECTIONS: FieldSectionSpec[] = [
  {
    title: "Damage",
    help: "damage = base × mass^massPower × fit × power × part multiplier × armour factor.",
    fields: [
      { key: "damage.base", label: "Base damage", kind: "number", min: 0, def: 10 },
      { key: "damage.massPower", label: "Mass power", kind: "number", min: 0, def: 0.5, help: "How much a heavier weapon adds. 0: mass doesn't matter." },
      { key: "damage.armourHalf", label: "Armour halves at", kind: "number", min: 0, def: 10, help: "The armour value that halves a blow." },
    ],
  },
  {
    title: "Power",
    help: "power = novice + masterBonus × m^curve.",
    fields: [
      { key: "power.novice", label: "Novice power", kind: "number", min: 0, def: 0.4 },
      { key: "power.masterBonus", label: "Master bonus", kind: "number", min: 0, def: 1.6 },
      { key: "power.curve", label: "Curve", kind: "number", min: 0, def: 1.5, help: "Above 1, power comes late in training." },
    ],
  },
  {
    title: "Fit",
    help: "How well a weapon suits a technique: fit + (1 − fit) × closes × m^masteryPower. Mastery closes the gap.",
    fields: [
      { key: "fit.closes", label: "Mastery closes", ...share, def: 0.8 },
      { key: "fit.masteryPower", label: "Mastery power", kind: "number", min: 0, def: 2 },
    ],
  },
  {
    title: "Precision",
    help: "Chance a blow lands on the aimed part: novice + masterBonus × m.",
    fields: [
      { key: "precision.novice", label: "Novice", ...share, def: 0.3 },
      { key: "precision.masterBonus", label: "Master bonus", ...share, def: 0.65 },
    ],
  },
  {
    title: "Defence",
    help: "A guard facing a blow stops it with chance base + perSkill × (defender's skill − attacker's), kept within min and max.",
    fields: [
      { key: "defence.base", label: "Base chance", ...share, def: 0.5 },
      { key: "defence.perSkill", label: "Per skill", kind: "number", min: 0, def: 1 },
      { key: "defence.min", label: "Least chance", ...share, def: 0.05 },
      { key: "defence.max", label: "Most chance", ...share, def: 0.95 },
      { key: "defence.failedLetsThrough", label: "Lost guard lets through", ...share, def: 0.5, help: "Share of the blow that gets past a guard that loses." },
      { key: "defence.disarmMargin", label: "Disarm margin", ...share, def: 0.3, help: "A parry disarms when the defender knows disarm and out-skills the attacker by this share." },
    ],
  },
];

/** One body part (body.json parts[i]). */
export const BODY_PART_FIELDS: FieldSpec[] = [
  { key: "name", label: "Name", kind: "text" },
  { key: "parent", label: "Hangs from", kind: "enum", options: "parts", nullable: true, help: "Losing a part loses everything below it. Empty: the root." },
  { key: "share", label: "Share of health", kind: "number", min: 0, max: 1, help: "All parts' shares add up to 1." },
  { key: "hitMultiplier", label: "Hit multiplier", kind: "number", min: 0, def: 1, help: "Damage multiplier for blows that land here." },
  { key: "atZero", label: "At 0 health", kind: "enum", options: ["death", "useless", "drop", "cannotStand", "none"], def: "useless" },
  { key: "slot", label: "Appearance slot", kind: "text", optional: true, help: "The slot that draws it; hidden when dismembered." },
  { key: "holds", label: "Holds", kind: "enum", options: ["main", "off"], optional: true, help: "A hand: which hand's item it holds." },
];

const severity = (kind: string): FieldSpec[] => [
  { key: `severity.${kind}.maim`, label: `${kind}: maims at`, ...share, def: null, help: "Share of the part's health one blow must take." },
  { key: `severity.${kind}.dismember`, label: `${kind}: dismembers at`, ...share, def: null },
  { key: `severity.${kind}.dismemberMaimed`, label: `${kind}: dismembers maimed at`, ...share, def: null },
];

const treatment = (kind: string, what: string): FieldSpec[] => [
  { key: `treatment.${kind}.seconds`, label: `${what}: novice time (s)`, kind: "number", min: 0 },
  { key: `treatment.${kind}.difficulty`, label: `${what}: difficulty`, ...share },
];

/** body.json beside its parts (docs/MASTERY-AND-COMBAT.md §4). */
export const BODY_SECTIONS: FieldSectionSpec[] = [
  {
    title: "Severity",
    help: "One blow of at least this share of a part's health maims or dismembers it. Empty: that kind never does.",
    fields: [{ key: "harmedBelow", label: "Harmed below", ...share, def: 0.4, help: "Harmed-part penalties apply below this share of health." }, ...severity("cut"), ...severity("blunt"), ...severity("thrust")],
  },
  {
    title: "Blood and healing",
    help: "Open wounds bleed until they clot or are bandaged; a stump never clots.",
    fields: [
      { key: "blood.max", label: "Blood", kind: "number", min: 0, def: 100 },
      { key: "blood.bleedPerSecond.cut", label: "Cut bleeds / s", kind: "number", min: 0, def: 0 },
      { key: "blood.bleedPerSecond.thrust", label: "Thrust bleeds / s", kind: "number", min: 0, def: 0 },
      { key: "blood.bleedPerSecond.dismember", label: "Stump bleeds / s", kind: "number", min: 0, def: 0 },
      { key: "blood.clotSeconds.cut", label: "Cut clots after (s)", kind: "number", min: 0, def: null, help: "Empty: only treatment stops it." },
      { key: "blood.clotSeconds.thrust", label: "Thrust clots after (s)", kind: "number", min: 0, def: null },
      { key: "blood.regenPerSecond", label: "Blood made back / s", kind: "number", min: 0, def: 0 },
      { key: "healPerSecond", label: "Healing / s (share)", ...share, def: 0, help: "Harmed parts that no longer bleed heal this share of health a second." },
    ],
  },
  {
    title: "Injury penalties",
    help: "What a weakened or useless part costs, as a share of normal.",
    fields: [
      { key: "penalties.weakArm", label: "Weak arm: power and precision", ...share, def: 0.75 },
      { key: "penalties.weakLeg", label: "Weak leg: speed", ...share, def: 0.75 },
      { key: "penalties.uselessLeg", label: "Useless leg: speed", ...share, def: 0.4, help: "And no jumping." },
      { key: "penalties.crawl", label: "Crawl: speed", ...share, def: 0.15, help: "Two useless legs, or useless hips." },
      { key: "penalties.weakTorsoStamina", label: "Weak torso: stamina recovery", ...share, def: 0.5 },
    ],
  },
  {
    title: "Falls",
    help: "Landing faster than the safe speed does blunt damage per m/s above it.",
    fields: [
      { key: "fall.safeSpeed", label: "Safe speed (m/s)", kind: "number", min: 0, def: 13 },
      { key: "fall.damagePerSpeed", label: "Damage per m/s", kind: "number", min: 0, def: 0 },
      { key: "fall.parts", label: "Shared out over", kind: "map", def: {}, help: "Part: share, e.g. legLeft: 0.35. Empty: by share over the whole body." },
    ],
  },
  {
    title: "Medicine",
    help: "A healer at Medicine m takes seconds × (1 − faster × m) and succeeds with chance base + perSkill × m − difficulty.",
    fields: [
      { key: "treatment.reach", label: "Reach (m)", kind: "number", min: 0, def: 2.5 },
      { key: "treatment.fasterPerSkill", label: "Faster per skill", ...share, def: 0.6 },
      { key: "treatment.chance.base", label: "Base chance", ...share, def: 0.6 },
      { key: "treatment.chance.perSkill", label: "Chance per skill", ...share, def: 0.8 },
      { key: "treatment.chance.min", label: "Least chance", ...share, def: 0.05 },
      ...treatment("bandage", "Bandage"),
      ...treatment("stump", "Close a stump"),
      ...treatment("set", "Set a maimed part"),
      { key: "treatment.set.minHp", label: "Set: heals to at least", ...share, def: 0.1 },
    ],
  },
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
  // An array stays an array (body parts are a list): copied, the index set.
  const out: Record<string, unknown> = Array.isArray(src) ? ([...src] as unknown as Record<string, unknown>) : { ...src };
  const next = rest.length === 0 ? value : setAt(src[head], rest.join("."), value);
  if (next === undefined) delete out[head];
  else out[head] = next;
  return out as T;
}

/** A field's value as the text its input shows ("" when absent). */
export function fieldText(spec: FieldSpec, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (spec.kind === "list" || spec.kind === "pair") return Array.isArray(value) ? value.join(spec.kind === "pair" ? "–" : ", ") : "";
  if (spec.kind === "map") return value !== null && typeof value === "object" ? Object.entries(value).map(([k, v]) => `${k}: ${String(v)}`).join(", ") : "";
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
  if (t === "") return spec.nullable ? null : undefined;
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
    case "map": {
      const out: Record<string, number> = {};
      for (const part of t.split(",").map((x) => x.trim()).filter((x) => x !== "")) {
        const m = /^([^:\s]+)\s*:\s*(\S+)$/.exec(part);
        const n = m ? Number(m[2]) : NaN;
        if (!m || !Number.isFinite(n)) return { error: "id: number, comma-separated, e.g. legLeft: 0.35" };
        out[m[1]] = n;
      }
      return out;
    }
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

/** Issues for `table`'s file (`<table>.json`) under `path` (the path itself, or a key or index below it). */
export function issuesAt(issues: readonly RulesIssue[], table: string, path: string): RulesIssue[] {
  const file = `${table}.json`;
  return issues.filter((i) => {
    if (i.file !== file) return false;
    // The rules package writes indexes as `parts[1].parent`; field paths are `parts.1.parent`.
    const p = i.path.replace(/\[(\d+)\]/g, ".$1");
    return p === path || p.startsWith(`${path}.`);
  });
}
