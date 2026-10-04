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

export type DungeonOp = { kind: "dungeon"; op: "enter"; entrance: string } | { kind: "dungeon"; op: "state" };

export interface DungeonEntranceView {
  id: string;
  name: string;
  x: number;
  z: number;
  radius: number;
}

export type DungeonMessage =
  | { kind: "dungeon"; op: "entrances"; entrances: DungeonEntranceView[] }
  /** Go play there: connect to `endpoint` and say hello with `{token}`. */
  | { kind: "dungeon"; op: "transfer"; endpoint: string; token: string; instance: string; dungeon: string }
  | { kind: "dungeon"; op: "state"; dungeon: string; secondsLeft: number; creaturesLeft: number; bossLeft: number }
  /** `items`: what this character earned, put in their bag in the region. */
  | { kind: "dungeon"; op: "ended"; outcome: "cleared" | "timeout" | "abandoned"; items: number };
