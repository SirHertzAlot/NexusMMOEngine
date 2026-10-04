/**
 * Quests and dialog on the wire (roadmap P1, catalog §0x11). JSON control
 * messages riding the chat envelope, like parties and guilds.
 *
 * C→S: `{kind:"quest", op:"talk", npc}` opens an npc's dialog (within its
 * talk range); `{kind:"quest", op:"reply", index}` picks a reply of the open
 * dialog; `{kind:"quest", op:"close"}` closes it; `{kind:"quest",
 * op:"abandon", quest}` drops a quest in progress.
 *
 * S→C: `npcs` once on entering the world (who gives quests, and where);
 * `quests` (the whole log) on entering and after every change; `dialog`
 * with the npc's line and the replies open to this character, or `closed`.
 */

export type QuestOp =
  | { kind: "quest"; op: "talk"; npc: string }
  | { kind: "quest"; op: "reply"; index: number }
  | { kind: "quest"; op: "close" }
  | { kind: "quest"; op: "abandon"; quest: string };

export interface QuestStepView {
  text: string;
  done: boolean;
  /** Toward `target` (kills, items; 0 or 1 for talk and reach). */
  progress: number;
  target: number;
}

export interface QuestView {
  id: string;
  name: string;
  /** The giver's display name, and id (their marker in `npcs`). */
  giver: string;
  giverId: string;
  summary: string;
  /** "ready": every step done, hand it in to the giver. */
  state: "active" | "ready" | "done";
  /** Done steps and the current one; steps further on stay hidden. */
  steps: QuestStepView[];
  rewards: { base: string; count: number }[];
}

export interface QuestLogMessage {
  kind: "quests";
  quests: QuestView[];
}

export interface NpcView {
  id: string;
  name: string;
  x: number;
  z: number;
  /** "ready": has a quest of yours to take back; "offer": has a quest you can take; null: neither. */
  marker: "ready" | "offer" | null;
}

export interface NpcsMessage {
  kind: "npcs";
  npcs: NpcView[];
}

export type DialogMessage =
  | { kind: "dialog"; npc: string; name: string; text: string; replies: { index: number; text: string }[] }
  | { kind: "dialog"; npc: string; closed: true };
