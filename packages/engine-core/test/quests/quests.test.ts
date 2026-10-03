/**
 * Quests and dialog (roadmap P1): the shipped content checks out; WFC
 * generation is deterministic and keeps needs and exclusions; a quest log
 * runs its steps in order and survives a reload; the service drives dialog,
 * progress, hand-in and rewards end to end.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComponent } from "bitecs";
import type { DialogMessage, NpcsMessage, QuestLogMessage } from "@mmo-engine/protocol";
import { SimWorld } from "../../src/world.js";
import * as C from "../../src/components.js";
import { checkQuestContent, loadQuestContent, parseQuestContent, QuestContentError, type QuestContent } from "../../src/quests/content.js";
import { generateQuest, QuestGenerationError } from "../../src/quests/generate.js";
import { authoredQuest } from "../../src/quests/quest-def.js";
import { MAX_ACTIVE_QUESTS, MemoryQuestStore, QuestLog } from "../../src/quests/quest-log.js";
import { QuestService } from "../../src/quests/quest-service.js";
import { SqliteQuestStore } from "../../src/quests/quest-store.js";
import type { ExtensionPlayer } from "../../src/net/extension.js";

const content = loadQuestContent();
const goblins = [{ id: "goblin", name: "Goblin" }];
const bindings = { giver: "warden", species: goblins, items: ["dagger", "axe"] };

describe("quest content", () => {
  it("the shipped content loads with no problems", () => {
    assert.deepEqual(checkQuestContent(content), []);
    assert.ok(Object.keys(content.quests).length >= 2);
  });

  it("names every cross-file problem", () => {
    const broken: QuestContent = structuredClone(content);
    broken.steps["bad-twist"] = { stage: "twist", text: "x", objective: { type: "talk", npc: "$nobody" }, weight: 1, gives: [], needs: ["map"], excludes: [] };
    broken.quests["lost"] = { name: "Lost", giver: "ghost", summary: "s", steps: [{ id: "a", text: "a", objective: { type: "reach", place: "nowhere" } }], rewards: [], repeatable: false, after: ["missing"] };
    broken.dialogs.warden.nodes.orphan = { text: "unreached", replies: [{ text: "go", next: "void" }] };
    const problems = checkQuestContent(broken);
    for (const want of [/needs "map", which no step of an earlier stage gives/, /unknown binding "\$nobody"/, /unknown giver "ghost"/, /reach unknown place "nowhere"/, /after unknown quest "missing"/, /node "orphan" can't be reached/, /missing node "void"/]) {
      assert.ok(problems.some((p) => want.test(p)), `${want} in ${problems.join(" | ")}`);
    }
  });

  it("refuses malformed files with file and path", () => {
    assert.throws(
      () => parseQuestContent({ steps: { version: 1, stages: [], steps: {}, templates: {} }, quests: { version: 1, quests: { Bad: {} } }, npcs: { version: 1, npcs: {} }, dialogs: { version: 1, dialogs: {} } }),
      (e: unknown) => e instanceof QuestContentError && e.problems.some((p) => p.startsWith("quests.json: quests.Bad")) && e.problems.some((p) => p.startsWith("steps.json: stages")),
    );
  });
});

describe("quest generation", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const a = generateQuest(content, "expedition", bindings, 7);
    assert.deepEqual(generateQuest(content, "expedition", bindings, 7), a);
    const variety = new Set<string>();
    for (let s = 0; s < 40; s++) variety.add(generateQuest(content, "expedition", bindings, s).steps.map((x) => x.id).join());
    assert.ok(variety.size > 4, `${variety.size} distinct step sequences`);
    assert.equal(a.steps.length, content.templates.expedition.stages.length);
    assert.equal(a.id, "board:warden:expedition:7");
  });

  it("keeps needs (a betrayal needs an earlier scout) and exclusions, and binds everything", () => {
    for (let s = 0; s < 300; s++) {
      const q = generateQuest(content, "expedition", bindings, s);
      const kinds = q.steps.map((x) => x.id.replace(/^\d+-/, ""));
      if (kinds.includes("betrayal")) assert.ok(kinds.includes("scout"), `seed ${s}: ${kinds}`);
      assert.ok(!(kinds.includes("supplies") && kinds.includes("doubled-back")), `seed ${s}: ${kinds}`);
      for (const st of q.steps) {
        assert.ok(!/[{}$]/.test(st.text), st.text);
        const o = st.objective;
        if (o.type === "kill") assert.equal(o.kind, "goblin");
        if (o.type === "talk") assert.equal(o.npc, "warden");
        if (o.type === "reach") assert.ok(content.npcs.warden.places.some((p) => p.name === o.place && p.x === o.x));
        if (o.type === "collect") assert.ok(["dagger", "axe"].includes(o.base));
      }
      assert.ok(q.rewards.every((r) => !r.base.startsWith("$")));
    }
  });

  it("leaves out steps the world can't bind, and says when a stage can't be filled", () => {
    const noItems = { ...bindings, items: [] };
    for (let s = 0; s < 50; s++) assert.ok(generateQuest(content, "expedition", noItems, s).steps.every((x) => x.objective.type !== "collect"));
    assert.throws(() => generateQuest(content, "bounty", { ...bindings, species: [] }, 1), QuestGenerationError);
    assert.throws(() => generateQuest(content, "nope", bindings, 1), /unknown template/);
  });
});

describe("quest log", () => {
  const tower = content.npcs.warden.places[0];

  it("runs steps in order: talk, reach, kills, talk; then ready, done, and not offered again", () => {
    const store = new MemoryQuestStore();
    const log = new QuestLog(42, store, () => 1000);
    const q = authoredQuest(content, "goblin-trouble");
    assert.equal(log.status(q), "available");
    assert.deepEqual(log.accept(q), { ok: true });
    assert.equal(log.accept(q).ok, false);
    assert.deepEqual(log.apply({ type: "kill", kind: "goblin" }), [], "kills before the tower don't count");
    assert.deepEqual(log.apply({ type: "talk", npc: "warden" }), ["goblin-trouble"]);
    assert.deepEqual(log.apply({ type: "reach", x: tower.x + 100, z: tower.z }), []);
    log.apply({ type: "reach", x: tower.x + 3, z: tower.z - 3 });
    for (let i = 0; i < 3; i++) log.apply({ type: "kill", kind: "goblin" });
    assert.equal(log.get("goblin-trouble")!.step, 3);
    assert.equal(log.complete("goblin-trouble").ok, false, "not handed in before the last talk");
    log.apply({ type: "talk", npc: "warden" });
    assert.equal(log.status(q), "ready");
    assert.deepEqual(log.complete("goblin-trouble"), { ok: true });
    assert.equal(log.status(q), "done");
    assert.equal(log.accept(q).ok, false);
    // Reloaded from the store: the same state.
    assert.equal(new QuestLog(42, store).status(q), "done");
  });

  it("prerequisites, abandoning, collect counts and the active limit", () => {
    const log = new QuestLog(1, new MemoryQuestStore());
    const stones = authoredQuest(content, "standing-stones");
    assert.equal(log.status(stones), "unavailable");
    assert.equal(log.accept(stones).ok, false);
    const gen = generateQuest(content, "bounty", bindings, 3);
    log.accept(gen);
    assert.deepEqual(log.abandon(gen.id), { ok: true });
    assert.equal(log.status(gen), "available");
    const collect = { ...gen, id: "c", steps: [{ id: "s", text: "t", objective: { type: "collect" as const, base: "axe", count: 2 } }] };
    log.accept(collect);
    log.apply({ type: "collect", count: () => 1 });
    assert.equal(log.get("c")!.progress, 1);
    log.apply({ type: "collect", count: (b) => (b === "axe" ? 2 : 0) });
    assert.equal(log.status(collect), "ready");
    for (let i = 0; log.activeCount < MAX_ACTIVE_QUESTS; i++) assert.ok(log.accept({ ...gen, id: `q${i}` }).ok);
    assert.match((log.accept({ ...gen, id: "one-more" }) as { reason: string }).reason, /full/);
  });

  it("the SQLite store keeps logs across reopening", () => {
    const dir = mkdtempSync(join(tmpdir(), "quests-"));
    try {
      const file = join(dir, "quests.db");
      let store = new SqliteQuestStore(file);
      const log = new QuestLog(7, store);
      const gen = generateQuest(content, "expedition", bindings, 11);
      log.accept(gen);
      log.apply({ type: "talk", npc: "warden" });
      store.close();
      store = new SqliteQuestStore(file);
      const back = new QuestLog(7, store);
      assert.deepEqual(back.get(gen.id)!.def, gen);
      assert.equal(back.get(gen.id)!.step, log.get(gen.id)!.step);
      back.abandon(gen.id);
      assert.deepEqual(store.load(7), []);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("quest service", () => {
  function setup() {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const avatar = sim.spawn();
    for (const c of [C.Transform, C.Health, C.CharacterRef]) addComponent(sim.ecs, c, avatar);
    C.CharacterRef.idHi[avatar] = 0;
    C.CharacterRef.idLo[avatar] = 5;
    const goblin = sim.spawn();
    addComponent(sim.ecs, C.Transform, goblin);
    const sent: object[] = [];
    let inventoryRefreshes = 0;
    const player: ExtensionPlayer = {
      characterId: 5,
      username: "hero",
      name: "Aldric",
      entity: () => avatar,
      send: (m) => sent.push(m),
      refreshInventory: () => inventoryRefreshes++,
    };
    const granted: string[] = [];
    const svc = new QuestService({
      content,
      store: new MemoryQuestStore(),
      speciesNear: () => goblins,
      itemBases: () => ["dagger"],
      countInBag: () => 0,
      grant: (_c, base) => (granted.push(base), true),
      checkEveryTicks: 1,
      now: () => 3 * 86_400_000,
    });
    const at = (x: number, z: number): void => {
      C.Transform.px[avatar] = x;
      C.Transform.pz[avatar] = z;
    };
    let tick = 0;
    const tickOnce = (): void => {
      sim.beginTick(++tick);
      svc.step(sim);
      sim.endTick();
    };
    const of = <T>(kind: string): T[] => sent.filter((m) => (m as { kind: string }).kind === kind) as T[];
    const last = <T>(kind: string): T => of<T>(kind).at(-1)!;
    const say = (op: object): void => svc.onMessage(player, { kind: "quest", ...op });
    return { sim, avatar, goblin, player, svc, at, tickOnce, of, last, say, granted, sent, refreshes: () => inventoryRefreshes };
  }

  it("dialog to quest to hand-in: offers, accepts, tracks, rewards", () => {
    const t = setup();
    const w = content.npcs.warden;
    t.at(w.x + 1, w.z);
    t.svc.onEnter(t.player);
    assert.deepEqual(t.last<QuestLogMessage>("quests").quests, []);
    assert.equal(t.last<NpcsMessage>("npcs").npcs[0].marker, "offer");
    t.say({ op: "talk", npc: "warden" });
    let d = t.last<Extract<DialogMessage, { text: string }>>("dialog");
    assert.match(d.text, /Aldric/);
    const texts = d.replies.map((r) => r.text);
    assert.ok(texts.includes("Uneasy how?") && texts.includes("Any work on the board?"));
    assert.ok(!texts.includes("What draws them to the stones?"), "the second quest waits for the first");
    t.say({ op: "reply", index: d.replies.find((r) => r.text === "Uneasy how?")!.index });
    d = t.last("dialog");
    t.say({ op: "reply", index: d.replies.find((r) => r.text === "I'll see to it.")!.index });
    assert.equal(t.last<{ closed?: boolean }>("dialog").closed, true);
    let q = t.last<QuestLogMessage>("quests").quests[0];
    assert.equal(q.id, "goblin-trouble");
    assert.deepEqual(q.steps.map((s) => s.done), [true, false], "talking to the warden was the first step");
    // Walk to the tower, kill three goblins (killer's quests count).
    const tower = w.places[0];
    t.at(tower.x, tower.z);
    t.tickOnce();
    for (let i = 0; i < 3; i++) t.svc.onDeath(t.sim, { tick: 1, target: t.goblin, state: "dead", killer: t.avatar }, () => "goblin");
    q = t.last<QuestLogMessage>("quests").quests[0];
    assert.equal(q.steps.at(-1)!.text, "Report back to Warden Hale.");
    // Back to the warden: the talk finishes the last step; hand it in.
    t.at(w.x, w.z + 2);
    t.say({ op: "talk", npc: "warden" });
    assert.equal(t.last<QuestLogMessage>("quests").quests[0].state, "ready");
    d = t.last("dialog");
    t.say({ op: "reply", index: d.replies.find((r) => /goblins at the tower/.test(r.text))!.index });
    assert.equal(t.last<QuestLogMessage>("quests").quests[0].state, "done");
    assert.deepEqual(t.granted, ["sword"]);
    assert.equal(t.refreshes(), 1);
    d = t.last("dialog");
    assert.match(d.text, /earned/);
    // Now the stones are on offer.
    t.say({ op: "reply", index: d.replies.find((r) => r.text === "Anything else?")!.index });
    assert.ok(t.last<Extract<DialogMessage, { text: string }>>("dialog").replies.some((r) => r.text === "What draws them to the stones?"));
  });

  it("takes the board's quest of the day, refuses talks out of range and bad ops", () => {
    const t = setup();
    const w = content.npcs.warden;
    t.svc.onEnter(t.player);
    t.at(w.x + 50, w.z);
    t.say({ op: "talk", npc: "warden" });
    assert.equal(t.of("dialog").length, 0);
    t.at(w.x, w.z);
    t.say({ op: "talk", npc: "warden" });
    let d = t.last<Extract<DialogMessage, { text: string }>>("dialog");
    t.say({ op: "reply", index: d.replies.find((r) => r.text === "Any work on the board?")!.index });
    d = t.last("dialog");
    const board = t.svc.boardQuest("warden", 5)!;
    assert.equal(d.text, `Today's posting: ${board.name}.`);
    t.say({ op: "reply", index: d.replies.find((r) => r.text === "I'll take it.")!.index });
    assert.equal(t.last<QuestLogMessage>("quests").quests[0].id, board.id);
    t.say({ op: "reply", index: 0 });
    t.say({ op: "dance" });
    const notices = t.sent.filter((m) => (m as { channel?: string }).channel === "system").map((m) => (m as { text: string }).text);
    assert.ok(notices.includes("nobody to talk to there") && notices.includes("no dialog open") && notices.includes("malformed quest op"), notices.join(" | "));
    t.say({ op: "abandon", quest: board.id });
    assert.deepEqual(t.last<QuestLogMessage>("quests").quests, []);
  });

  it("walking away closes the dialog; a characterless session gets no log", () => {
    const t = setup();
    const w = content.npcs.warden;
    t.svc.onEnter(t.player);
    t.at(w.x, w.z);
    t.say({ op: "talk", npc: "warden" });
    t.at(w.x + 40, w.z);
    t.tickOnce();
    assert.equal(t.last<{ closed?: boolean }>("dialog").closed, true);
    const sent: object[] = [];
    t.svc.onEnter({ ...t.player, characterId: null, send: (m) => sent.push(m) });
    assert.deepEqual(sent, []);
  });
});
