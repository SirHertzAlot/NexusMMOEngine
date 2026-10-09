/**
 * The Play menu's setup (EA14) and the saved-setups document
 * `content/play/setups.json`. Pure and browser-safe: the editor UI and the
 * host both validate with it, and a refused save writes nothing.
 */

export const WHERE = ["viewport", "window", "simulate"] as const;
export const NETWORKS = ["Core only", "Edge + core"] as const;
export const LATENCIES = ["0", "80 ms", "200 ms"] as const;
export const CAMERA = "@camera";
/** Keys a saved setup may bind: F5/Shift F5 are Play/Stop, F11/F12 belong to the browser. */
export const SETUP_SHORTCUTS = ["F6", "F7", "F8", "F9", "F10", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Alt+${n}`)] as const;

export interface PlaySetup {
  /** viewport (the embedded game view), window (the player's client), simulate (world only, nobody joins). */
  where: string;
  /** A flow node id, or "@camera" (spawn at the Scenes viewport camera). */
  from: string;
  /** "1".."8": one seeded account each. */
  clients: string;
  /** MMO_BOTS, "0".."1000". */
  bots: string;
  net: string;
  latency: string;
  /** A fresh world (terrain and baked data only) instead of continuing the saved one. */
  fresh: boolean;
  /** Keep play changes on stop (write the session's state back to the saved world). */
  keep: boolean;
  tint: boolean;
}

export const DEFAULT_PLAY_SETUP: PlaySetup = {
  where: "viewport",
  from: "world",
  clients: "1",
  bots: "10",
  net: "Edge + core",
  latency: "0",
  fresh: true,
  keep: false,
  tint: true,
};

export function defaultPlaySetup(): PlaySetup {
  return { ...DEFAULT_PLAY_SETUP };
}

const LEGACY_FROM: Record<string, string> = {
  Login: "login",
  "Character creation": "character-creation",
  World: "world",
  "Camera position": CAMERA,
};

const isCount = (v: string, max: number): boolean => /^\d{1,4}$/.test(v) && Number(v) <= max;

/** Every problem with a setup (empty = valid). */
export function checkPlaySetup(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return ["setup must be an object"];
  const r = raw as Record<string, unknown>;
  const issues: string[] = [];
  const str = (f: string, ok: (v: string) => boolean, hint: string): void => {
    if (typeof r[f] !== "string" || !ok(r[f] as string)) issues.push(`${f}: ${hint}`);
  };
  str("where", (v) => (WHERE as readonly string[]).includes(v), `one of ${WHERE.join(", ")}`);
  str("from", (v) => v === CAMERA || /^[a-z0-9][a-z0-9-]{0,39}$/.test(v), 'a flow node id or "@camera"');
  str("clients", (v) => isCount(v, 8) && Number(v) >= 1, "1 to 8");
  str("bots", (v) => isCount(v, 1000), "0 to 1000");
  str("net", (v) => (NETWORKS as readonly string[]).includes(v), `one of ${NETWORKS.join(", ")}`);
  str("latency", (v) => (LATENCIES as readonly string[]).includes(v), `one of ${LATENCIES.join(", ")}`);
  for (const f of ["fresh", "keep", "tint"]) if (typeof r[f] !== "boolean") issues.push(`${f}: true or false`);
  return issues;
}

/** Validate an unknown value into a PlaySetup (anything invalid falls back to the default). */
export function normalizePlaySetup(raw: unknown): PlaySetup {
  const out = defaultPlaySetup();
  if (typeof raw !== "object" || raw === null) return out;
  const r = { ...(raw as Record<string, unknown>) };
  if (typeof r.from === "string" && r.from in LEGACY_FROM) r.from = LEGACY_FROM[r.from];
  for (const f of ["where", "from", "clients", "bots", "net", "latency"] as const) {
    if (typeof r[f] === "string" && checkPlaySetup({ ...out, [f]: r[f] }).length === 0) out[f] = r[f] as string;
  }
  for (const f of ["fresh", "keep", "tint"] as const) if (typeof r[f] === "boolean") out[f] = r[f] as boolean;
  return out;
}

/** Bots count the owned server can honor (MMO_BOTS). NaN to 0. */
export function botsCount(setup: PlaySetup): number {
  const n = Number(setup.bots);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
export const clientCount = (setup: PlaySetup): number => Math.min(8, Math.max(1, Math.floor(Number(setup.clients)) || 1));
/** Round-trip delay added to every client connection, in ms. */
export const latencyMs = (setup: PlaySetup): number => parseInt(setup.latency, 10) || 0;
export const useEdge = (setup: PlaySetup): boolean => setup.net === "Edge + core";

export interface SavedPlaySetup {
  name: string;
  /** One of SETUP_SHORTCUTS; absent = no key. */
  shortcut?: string;
  setup: PlaySetup;
}
export interface PlaySetupsDoc {
  version: 1;
  setups: SavedPlaySetup[];
}

export const emptySetups = (): PlaySetupsDoc => ({ version: 1, setups: [] });

/** Every problem with a setups document (empty = valid). */
export function validatePlaySetups(doc: unknown): string[] {
  if (typeof doc !== "object" || doc === null) return ["document must be an object"];
  const d = doc as { version?: unknown; setups?: unknown };
  if (d.version !== 1) return ["version must be 1"];
  if (!Array.isArray(d.setups)) return ["setups must be a list"];
  const issues: string[] = [];
  const names = new Set<string>();
  const keys = new Set<string>();
  d.setups.forEach((s: unknown, i) => {
    const e = s as Partial<SavedPlaySetup> | null;
    const at = `setups[${i}]`;
    if (typeof e !== "object" || e === null) return void issues.push(`${at}: must be an object`);
    if (typeof e.name !== "string" || e.name.trim() === "" || e.name.length > 40) issues.push(`${at}: name must be 1 to 40 characters`);
    else if (names.has(e.name)) issues.push(`${at}: duplicate name "${e.name}"`);
    else names.add(e.name);
    if (e.shortcut !== undefined) {
      if (!(SETUP_SHORTCUTS as readonly string[]).includes(e.shortcut)) issues.push(`${at}: shortcut must be one of ${SETUP_SHORTCUTS.join(", ")}`);
      else if (keys.has(e.shortcut)) issues.push(`${at}: shortcut ${e.shortcut} is already bound`);
      else keys.add(e.shortcut);
    }
    for (const p of checkPlaySetup(e.setup)) issues.push(`${at}.setup.${p}`);
  });
  return issues;
}

/** The shortcut string a key event spells (F6, Alt+3), or null when it is not a setup key. */
export function setupShortcutOf(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): string | null {
  if (e.ctrlKey || e.metaKey || e.shiftKey) return null;
  const k = e.altKey ? `Alt+${e.key}` : e.key;
  return (SETUP_SHORTCUTS as readonly string[]).includes(k) ? k : null;
}

/** The saved setup bound to a key event, if any. */
export function setupForKey(doc: PlaySetupsDoc, e: Parameters<typeof setupShortcutOf>[0]): SavedPlaySetup | null {
  const k = setupShortcutOf(e);
  return k === null ? null : (doc.setups.find((s) => s.shortcut === k) ?? null);
}

/** One-line chip: what Play will do ("In viewport · world · 1 client · edge + core"). */
export function setupSummary(setup: PlaySetup): string {
  const where = setup.where === "viewport" ? "In viewport" : setup.where === "window" ? "New window" : "Simulate";
  const n = clientCount(setup);
  const bots = botsCount(setup);
  return [
    where,
    setup.from === CAMERA ? "camera" : setup.from,
    `${n} client${n === 1 ? "" : "s"}`,
    ...(bots > 0 ? [`${bots} bots`] : []),
    useEdge(setup) ? "edge + core" : "core only",
    ...(latencyMs(setup) > 0 ? [`${latencyMs(setup)} ms`] : []),
  ].join(" · ");
}
