/**
 * A character's quest log (roadmap P1): what they have taken, where each
 * quest stands, and what they have finished.
 *
 * A quest's steps run in order. The current step's objective counts up on
 * the events that match it (a talk with its npc, a kill of its kind, standing
 * in its place, enough of its item in the bag); when it reaches its target
 * the next step starts. Once every step is done the quest is "ready": its
 * giver takes it back (the dialog's `complete` action), the rewards are
 * granted and it is "done". Done quests stay in the log, so a quest that
 * isn't repeatable is offered once.
 *
 * Every change is written through to the QuestStore at once.
 */

import { objectiveTarget, type QuestDef } from "./quest-def.js";

/** At most this many quests in progress at once. */
export const MAX_ACTIVE_QUESTS = 25;

export interface QuestRecord {
  def: QuestDef;
  state: "active" | "done";
  /** Index of the current step (steps.length: every step done, ready to hand in). */
  step: number;
  /** Progress of the current step toward its objective's target. */
  progress: number;
  /** When it was taken and finished, ms since the epoch. */
  acceptedAt: number;
  doneAt?: number;
}

/** Quest logs, per character id (write-through: every change saves at once). */
export interface QuestStore {
  load(characterId: number): QuestRecord[];
  save(characterId: number, record: QuestRecord): void;
  remove(characterId: number, questId: string): void;
}

export class MemoryQuestStore implements QuestStore {
  private readonly rows = new Map<number, Map<string, QuestRecord>>();
  load(characterId: number): QuestRecord[] {
    return [...(this.rows.get(characterId)?.values() ?? [])].map((r) => structuredClone(r));
  }
  save(characterId: number, record: QuestRecord): void {
    let m = this.rows.get(characterId);
    if (!m) this.rows.set(characterId, (m = new Map()));
    m.set(record.def.id, structuredClone(record));
  }
  remove(characterId: number, questId: string): void {
    this.rows.get(characterId)?.delete(questId);
  }
}

/** Where a quest stands for one character. "available": they may take it; "unavailable": not (done, or its prerequisites aren't). */
export type QuestStatus = "available" | "active" | "ready" | "done" | "unavailable";

export type QuestEvent =
  | { type: "talk"; npc: string }
  | { type: "kill"; kind: string }
  | { type: "reach"; x: number; z: number }
  | { type: "collect"; count: (base: string) => number };

export type LogResult = { ok: true } | { ok: false; reason: string };

export class QuestLog {
  private readonly records = new Map<string, QuestRecord>();

  constructor(
    readonly characterId: number,
    private readonly store: QuestStore,
    private readonly now: () => number = Date.now,
  ) {
    for (const r of store.load(characterId)) this.records.set(r.def.id, r);
  }

  get(id: string): QuestRecord | undefined {
    return this.records.get(id);
  }

  /** Every quest in the log, in the order taken. */
  all(): QuestRecord[] {
    return [...this.records.values()].sort((a, b) => a.acceptedAt - b.acceptedAt);
  }

  get activeCount(): number {
    let n = 0;
    for (const r of this.records.values()) if (r.state === "active") n++;
    return n;
  }

  /** The status of quest `def` (or of an id never offered: "available" unless `after` blocks it). */
  status(def: Pick<QuestDef, "id" | "repeatable" | "after">): QuestStatus {
    const r = this.records.get(def.id);
    if (r?.state === "active") return r.step >= r.def.steps.length ? "ready" : "active";
    if (r?.state === "done" && !def.repeatable) return "done";
    for (const a of def.after) if (this.records.get(a)?.state !== "done") return "unavailable";
    return "available";
  }

  accept(def: QuestDef): LogResult {
    const st = this.status(def);
    if (st === "active" || st === "ready") return { ok: false, reason: "you are already on that quest" };
    if (st === "done") return { ok: false, reason: "you have done that quest" };
    if (st === "unavailable") return { ok: false, reason: "you can't take that quest yet" };
    if (this.activeCount >= MAX_ACTIVE_QUESTS) return { ok: false, reason: `your quest log is full (${MAX_ACTIVE_QUESTS})` };
    const r: QuestRecord = { def, state: "active", step: 0, progress: 0, acceptedAt: this.now() };
    this.records.set(def.id, r);
    this.store.save(this.characterId, r);
    return { ok: true };
  }

  abandon(id: string): LogResult {
    const r = this.records.get(id);
    if (!r || r.state !== "active") return { ok: false, reason: "you aren't on that quest" };
    this.records.delete(id);
    this.store.remove(this.characterId, id);
    return { ok: true };
  }

  /** Hand a ready quest in: it is done, and the caller grants its rewards. */
  complete(id: string): LogResult {
    const r = this.records.get(id);
    if (!r || r.state !== "active") return { ok: false, reason: "you aren't on that quest" };
    if (r.step < r.def.steps.length) return { ok: false, reason: "that quest isn't finished" };
    r.state = "done";
    r.doneAt = this.now();
    this.store.save(this.characterId, r);
    return { ok: true };
  }

  /** Apply an event to every active quest; returns the ids of the quests it moved on. */
  apply(e: QuestEvent): string[] {
    const changed: string[] = [];
    for (const r of this.records.values()) {
      if (r.state !== "active") continue;
      let moved = false;
      // One event can finish several steps in a row (two talks with the same npc).
      while (r.step < r.def.steps.length) {
        const before = r.progress;
        const o = r.def.steps[r.step].objective;
        const target = objectiveTarget(o);
        if (o.type === "talk" && e.type === "talk" && o.npc === e.npc) r.progress = target;
        else if (o.type === "kill" && e.type === "kill" && o.kind === e.kind) r.progress = Math.min(target, r.progress + 1);
        else if (o.type === "reach" && e.type === "reach" && (e.x - o.x) ** 2 + (e.z - o.z) ** 2 <= o.radius ** 2) r.progress = target;
        else if (o.type === "collect" && e.type === "collect") r.progress = Math.min(target, e.count(o.base));
        if (r.progress !== before) moved = true;
        if (r.progress < target) break;
        r.step++;
        r.progress = 0;
        moved = true;
        // A kill counts toward one step only; the next starts from zero.
        if (e.type === "kill") break;
      }
      if (moved) {
        this.store.save(this.characterId, r);
        changed.push(r.def.id);
      }
    }
    return changed;
  }
}
