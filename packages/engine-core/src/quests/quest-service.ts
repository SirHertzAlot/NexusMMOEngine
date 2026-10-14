/**
 * QuestService (roadmap P1): quests and dialog in a running region.
 *
 * It plugs into the gateway as the `quest` extension (0x11 `kind:"quest"`,
 * see GatewayExtension) and into the tick as a system:
 *
 *  - talking: a character within an npc's talk range opens its dialog; each
 *    reply shown is one whose condition holds for them, and picking it runs
 *    its action (take a quest, hand one in) and moves to its next node;
 *  - progress: kills come from DeathSystem (`onDeath`: the killer's quests
 *    count the victim's kind); places and items are checked every
 *    `checkEveryTicks` for characters in the world; talks count when the
 *    dialog opens;
 *  - the board: each npc with board templates offers every character one
 *    generated quest a day (seed: npc, character, day), built from the
 *    creatures living near the npc;
 *  - pushes: the whole log after any change, npc markers (an offer, a quest
 *    to hand in), and the open dialog.
 *
 * Quest logs are per character (an account playing without one has none).
 * All state is in the QuestStore; the service only keeps the logs of the
 * characters online.
 */

import { hasComponent } from "bitecs";
import type { DialogMessage, NpcsMessage, QuestLogMessage, QuestView } from "@mmo-engine/protocol";
import * as C from "../components.js";
import type { LifeEvent } from "../death.js";
import type { SimSystem } from "../systems.js";
import type { SimWorld } from "../world.js";
import { hash } from "../procgen/ecology.js";
import type { DialogAction, DialogCondition, DialogNode, NpcDef, QuestContent } from "./content.js";
import { generateQuest, QuestGenerationError } from "./generate.js";
import { authoredQuest, objectiveTarget, type QuestDef } from "./quest-def.js";
import { QuestLog, type QuestStatus, type QuestStore } from "./quest-log.js";
import type { ExtensionPlayer, GatewayExtension } from "../net/extension.js";

export interface QuestServiceOptions {
  content: QuestContent;
  store: QuestStore;
  /** Creature kinds (id and name) living around world (x, z), for board quests. */
  speciesNear: (x: number, z: number) => { id: string; name: string }[];
  /** Item bases a board quest may ask for or give. */
  itemBases: () => string[];
  /** How many items of `base` a character holds (collect steps). */
  countInBag?: (characterId: number, base: string) => number;
  /** Give a character one item of `base`; false when it couldn't (no such item, bag full). */
  grant?: (characterId: number, base: string) => boolean;
  /** Give a character gold (quest rewards); absent: gold rewards are skipped. */
  grantGold?: (characterId: number, amount: number) => void;
  /** Check places and bags every this many ticks (default 15: twice a second). */
  checkEveryTicks?: number;
  now?: () => number;
}

interface Online {
  player: ExtensionPlayer;
  log: QuestLog;
  dialog: { npc: string; node: string } | null;
}

const DAY_MS = 86_400_000;

export class QuestService implements SimSystem, GatewayExtension {
  readonly name = "quests";
  readonly kind = "quest";
  private readonly online = new Map<number, Online>();
  private readonly checkEvery: number;
  private readonly now: () => number;

  constructor(private readonly opts: QuestServiceOptions) {
    this.checkEvery = opts.checkEveryTicks ?? 15;
    this.now = opts.now ?? Date.now;
  }

  /** Quest content (slice 4): exposed for server bootstrap (scene spawn). */
  get content(): QuestContent {
    return this.opts.content;
  }

  // ---------------------------------------------------------- the gateway

  onEnter(player: ExtensionPlayer): void {
    if (player.characterId === null) return;
    const log = new QuestLog(player.characterId, this.opts.store, this.now);
    this.online.set(player.characterId, { player, log, dialog: null });
    this.pushLog(player.characterId);
    this.pushNpcs(player.characterId);
  }

  onLeave(player: ExtensionPlayer): void {
    if (player.characterId !== null) this.online.delete(player.characterId);
  }

  onMessage(player: ExtensionPlayer, raw: unknown): void {
    const o = player.characterId === null ? undefined : this.online.get(player.characterId);
    if (!o) {
      player.send({ kind: "chat", channel: "system", text: "quests need a character", from: "", entity: "" });
      return;
    }
    const m = raw as { op?: unknown; npc?: unknown; index?: unknown; quest?: unknown };
    if (m.op === "talk" && typeof m.npc === "string" && m.npc.length <= 64) this.talk(o, m.npc);
    else if (m.op === "reply" && Number.isInteger(m.index) && (m.index as number) >= 0 && (m.index as number) < 16) this.reply(o, m.index as number);
    else if (m.op === "close") this.closeDialog(o);
    else if (m.op === "abandon" && typeof m.quest === "string" && m.quest.length <= 128) {
      const r = o.log.abandon(m.quest);
      if (!r.ok) this.notice(o, r.reason);
      else this.changed(o);
    } else this.notice(o, "malformed quest op");
  }

  // ------------------------------------------------------------- the tick

  step(sim: SimWorld): void {
    if (this.online.size === 0 || sim.currentTick % this.checkEvery !== 0) return;
    for (const o of this.online.values()) {
      const e = o.player.entity();
      if (e < 0) continue;
      const changed = o.log.apply({ type: "reach", x: C.Transform.px[e], z: C.Transform.pz[e] });
      if (this.opts.countInBag) {
        const id = o.log.characterId;
        const count = this.opts.countInBag;
        changed.push(...o.log.apply({ type: "collect", count: (base) => count(id, base) }));
      }
      if (changed.length > 0) this.changed(o);
      // Walked away mid-dialog.
      if (o.dialog && !this.inRange(e, this.opts.content.npcs[o.dialog.npc])) this.closeDialog(o);
    }
  }

  /** DeathSystem's death hook: the killer's quests count the victim's kind. */
  onDeath(sim: SimWorld, ev: LifeEvent, kindOf: (e: number) => string | undefined): void {
    if (ev.state !== "dead" || ev.killer === undefined || !hasComponent(sim.ecs, C.CharacterRef, ev.killer)) return;
    const kind = kindOf(ev.target);
    if (kind === undefined) return;
    const o = this.online.get(C.CharacterRef.idHi[ev.killer] * 4294967296 + C.CharacterRef.idLo[ev.killer]);
    if (o && o.log.apply({ type: "kill", kind }).length > 0) this.changed(o);
  }

  /** A character's log (tests, the editor). */
  logOf(characterId: number): QuestLog | undefined {
    return this.online.get(characterId)?.log;
  }

  // ------------------------------------------------------------- the board

  /** The quest `npc`'s board offers this character today, or null (no board, or nothing fits here). */
  boardQuest(npc: string, characterId: number): QuestDef | null {
    const n = this.opts.content.npcs[npc];
    if (!n || n.board.length === 0) return null;
    const day = Math.floor(this.now() / DAY_MS);
    const seed = hash(hashString(npc), characterId | 0, Math.floor(characterId / 4294967296), day);
    const template = n.board[seed % n.board.length];
    try {
      return generateQuest(this.opts.content, template, { giver: npc, species: this.opts.speciesNear(n.x, n.z), items: this.opts.itemBases() }, seed);
    } catch (err) {
      if (err instanceof QuestGenerationError) return null;
      throw err;
    }
  }

  // ------------------------------------------------------------ dialog

  private talk(o: Online, npcId: string): void {
    const npc = this.opts.content.npcs[npcId];
    const e = o.player.entity();
    if (!npc || e < 0 || !this.inRange(e, npc)) {
      this.notice(o, "nobody to talk to there");
      return;
    }
    // Talking is progress for "talk to" steps (handing a quest back starts with one).
    if (o.log.apply({ type: "talk", npc: npcId }).length > 0) this.changed(o);
    o.dialog = { npc: npcId, node: this.opts.content.dialogs[npc.dialog].start };
    this.pushDialog(o);
  }

  private reply(o: Online, index: number): void {
    if (!o.dialog) {
      this.notice(o, "no dialog open");
      return;
    }
    const replies = this.openReplies(o);
    const r = replies.find((x) => x.index === index);
    if (!r) {
      this.notice(o, "no such reply");
      return;
    }
    if (r.reply.do && !this.act(o, r.reply.do)) {
      this.pushDialog(o);
      return;
    }
    if (r.reply.next === undefined) {
      this.closeDialog(o);
      return;
    }
    o.dialog.node = r.reply.next;
    this.pushDialog(o);
  }

  private act(o: Online, a: DialogAction): boolean {
    const npc = o.dialog!.npc;
    if ("accept" in a) {
      const def = this.questFor(a.accept, npc, o.log.characterId);
      if (!def) {
        this.notice(o, "there is no quest here for you now");
        return false;
      }
      const r = o.log.accept(def);
      if (!r.ok) {
        this.notice(o, r.reason);
        return false;
      }
      // A quest whose first step is talking to this npc moves on at once.
      o.log.apply({ type: "talk", npc });
      this.notice(o, `quest taken: ${def.name}`);
      this.changed(o);
      return true;
    }
    const id = this.questId(a.complete, npc, o.log);
    const rec = id === null ? undefined : o.log.get(id);
    if (!rec || rec.def.giver !== npc) {
      this.notice(o, "you have nothing to hand in here");
      return false;
    }
    const r = o.log.complete(rec.def.id);
    if (!r.ok) {
      this.notice(o, r.reason);
      return false;
    }
    let granted = 0;
    let goldGranted = 0;
    for (const reward of rec.def.rewards) {
      if (reward.gold !== undefined && reward.gold > 0) {
        this.opts.grantGold?.(o.log.characterId, reward.gold);
        goldGranted += reward.gold;
        granted++;
      }
      for (let i = 0; i < reward.count; i++) if (this.opts.grant?.(o.log.characterId, reward.base)) granted++;
    }
    if (granted > 0) o.player.refreshInventory();
    this.notice(o, `quest done: ${rec.def.name}${granted > 0 ? ` (${granted} reward${granted === 1 ? "" : "s"})` : ""}${goldGranted > 0 ? ` (+${goldGranted} gold)` : ""}`);
    this.changed(o);
    return true;
  }

  /** The concrete quest an action or condition names: an authored id, or "board" (today's board quest). */
  private questFor(ref: string, npc: string, characterId: number): QuestDef | null {
    if (ref === "board") return this.boardQuest(npc, characterId);
    return this.opts.content.quests[ref] ? authoredQuest(this.opts.content, ref) : null;
  }

  /** "board" means the board quest this character holds from `npc` (taken on an earlier day too), else today's. */
  private questId(ref: string, npc: string, log: QuestLog): string | null {
    if (ref !== "board") return ref;
    const held = log.all().find((r) => r.state === "active" && r.def.giver === npc && r.def.id.startsWith(`board:${npc}:`));
    return held?.def.id ?? this.boardQuest(npc, log.characterId)?.id ?? null;
  }

  private status(c: DialogCondition, npc: string, log: QuestLog): QuestStatus {
    if (c.quest === "board") {
      const id = this.questId("board", npc, log);
      const held = id === null ? undefined : log.get(id);
      if (held) return log.status(held.def);
      const today = this.boardQuest(npc, log.characterId);
      return today ? log.status(today) : "unavailable";
    }
    const q = this.opts.content.quests[c.quest];
    return q ? log.status({ id: c.quest, repeatable: q.repeatable, after: q.after }) : "unavailable";
  }

  private openReplies(o: Online): { index: number; reply: DialogNode["replies"][number] }[] {
    const d = o.dialog!;
    const node = this.opts.content.dialogs[this.opts.content.npcs[d.npc].dialog].nodes[d.node];
    return node.replies.flatMap((reply, index) => (!reply.if || this.status(reply.if, d.npc, o.log) === reply.if.is ? [{ index, reply }] : []));
  }

  private pushDialog(o: Online): void {
    const d = o.dialog!;
    const npc = this.opts.content.npcs[d.npc];
    const node = this.opts.content.dialogs[npc.dialog].nodes[d.node];
    const board = node.text.includes("{board}") ? this.boardQuest(d.npc, o.log.characterId) : null;
    const msg: DialogMessage = {
      kind: "dialog",
      npc: d.npc,
      name: npc.name,
      text: node.text.replaceAll("{name}", o.player.name).replaceAll("{board}", board?.name ?? "nothing today"),
      replies: this.openReplies(o).map((r) => ({ index: r.index, text: r.reply.text })),
    };
    o.player.send(msg);
  }

  private closeDialog(o: Online): void {
    if (!o.dialog) return;
    const msg: DialogMessage = { kind: "dialog", npc: o.dialog.npc, closed: true };
    o.dialog = null;
    o.player.send(msg);
  }

  // ------------------------------------------------------------ pushes

  private changed(o: Online): void {
    this.pushLog(o.log.characterId);
    this.pushNpcs(o.log.characterId);
  }

  private pushLog(characterId: number): void {
    const o = this.online.get(characterId);
    if (!o) return;
    const quests: QuestView[] = o.log.all().map((r) => {
      const ready = r.state === "active" && r.step >= r.def.steps.length;
      const shown = r.state === "done" ? r.def.steps.length : Math.min(r.step + 1, r.def.steps.length);
      return {
        id: r.def.id,
        name: r.def.name,
        giver: this.opts.content.npcs[r.def.giver]?.name ?? r.def.giver,
        giverId: r.def.giver,
        summary: r.def.summary,
        state: r.state === "done" ? "done" : ready ? "ready" : "active",
        steps: r.def.steps.slice(0, shown).map((s, i) => {
          const target = objectiveTarget(s.objective);
          const done = r.state === "done" || i < r.step;
          return { text: s.text, done, progress: done ? target : r.progress, target };
        }),
        rewards: r.def.rewards,
      };
    });
    const msg: QuestLogMessage = { kind: "quests", quests };
    o.player.send(msg);
  }

  private pushNpcs(characterId: number): void {
    const o = this.online.get(characterId);
    if (!o) return;
    const msg: NpcsMessage = {
      kind: "npcs",
      npcs: Object.entries(this.opts.content.npcs).map(([id, n]) => ({ id, name: n.name, x: n.x, z: n.z, marker: this.marker(id, o.log) })),
    };
    o.player.send(msg);
  }

  private marker(npc: string, log: QuestLog): "ready" | "offer" | null {
    for (const r of log.all()) if (r.state === "active" && r.def.giver === npc && r.step >= r.def.steps.length) return "ready";
    for (const [id, q] of Object.entries(this.opts.content.quests)) {
      if (q.giver === npc && log.status({ id, repeatable: q.repeatable, after: q.after }) === "available") return "offer";
    }
    const board = this.boardQuest(npc, log.characterId);
    return board && log.status(board) === "available" && !log.all().some((r) => r.state === "active" && r.def.id.startsWith(`board:${npc}:`)) ? "offer" : null;
  }

  private notice(o: Online, text: string): void {
    o.player.send({ kind: "chat", channel: "system", text, from: "", entity: "" });
  }

  private inRange(e: number, npc: NpcDef | undefined): boolean {
    if (!npc) return false;
    return (C.Transform.px[e] - npc.x) ** 2 + (C.Transform.pz[e] - npc.z) ** 2 <= npc.talkRange ** 2;
  }
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
