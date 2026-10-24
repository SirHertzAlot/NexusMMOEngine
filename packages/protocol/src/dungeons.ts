/**
 * Dungeon instances on the wire (roadmap D4, catalog "Dungeon instances").
 * JSON control messages riding the chat envelope (0x11), like quests.
 *
 * C→S (region): `{kind:"dungeon", op:"enter", entrance}` asks for a run at
 * an entrance the player stands within. C→S (instance): `{kind:"dungeon",
 * op:"state"}` asks for the run's state now.
 *
 * S→C (region): `entrances` on entering the world (where runs start);
 * `transfer` to each party member when a run starts or lets one back in.
 * S→C (instance): `state` on entering and every 5 s; `ended` when the run
 * is over.
 */

export type DungeonOp =
  | { kind: "dungeon"; op: "enter"; entrance: string }
  | { kind: "dungeon"; op: "state" };

export interface DungeonEntranceView {
  id: string;
  name: string;
  x: number;
  z: number;
  radius: number;
}

/**
 * How a dungeon run looks, one theme of content/dungeons/looks.json (colours are "#rrggbb"). Sent once when a
 * member enters; the client turns the sky and weather off, sets the fog and the dim ambient light, colours the
 * shell's material slots from `palette`, and lights the nearest `emitters` with `torch`, up to `maxLights`.
 */
export interface DungeonLook {
  theme: string;
  background: string;
  fog: { color: string; density: number };
  hemisphere: { sky: string; ground: string; intensity: number };
  dir: { color: string; intensity: number };
  /** The shell's material slots (floor, wall, ceiling, basin): matte colours. */
  palette: Record<string, string>;
  /** Asset ids that give light (dungeon:torch…). */
  emitters: string[];
  /** The light each emitter gives: range in metres, flicker 0..1. */
  torch: { color: string; intensity: number; range: number; flicker: number };
  /** Real point lights at once (the nearest emitters); the rest give none. */
  maxLights: number;
}

export type DungeonMessage =
  | { kind: "dungeon"; op: "entrances"; entrances: DungeonEntranceView[] }
  /** Go play there: connect to `endpoint` and say hello with `{token}`. */
  | { kind: "dungeon"; op: "transfer"; endpoint: string; token: string; instance: string; dungeon: string }
  /** How the run looks (sent once on entering). */
  | { kind: "dungeon"; op: "look"; look: DungeonLook }
  | { kind: "dungeon"; op: "state"; dungeon: string; secondsLeft: number; creaturesLeft: number; bossLeft: number; chests: { id: string; opened: boolean }[]; traps: { id: string; sprung: boolean }[] }
  /** `items`: what this character earned, put in their bag in the region. */
  | { kind: "dungeon"; op: "ended"; outcome: "cleared" | "timeout" | "abandoned"; items: number };
