/**
 * The player's body over the wire (roadmap M2, protocol 0x18): joining
 * sends it whole; an injury is sent within a few ticks, and only once.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { decodeControl, encodeControl, MessageType, type BodyMessage, type ErrorMessage, type TreatmentMessage, type SkillsMessage, type AdminResult, type ManaMessage, type SpellMessage } from "@mmo-engine/protocol";
import { CombatSystem } from "../../src/combat.js";
import { Gateway } from "../../src/net/gateway.js";
import { BodySystem } from "../../src/body.js";
import { MasterySystem } from "../../src/stats/mastery-system.js";
import { MagicSystem } from "../../src/magic.js";
import * as C from "../../src/components.js";
import { SimWorld } from "../../src/world.js";
import { loadGameRules } from "../../src/rules/boot.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

let now = 0;
let gw: Gateway | null = null;

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

describe("gateway: body", () => {
  it("sends the player's body on joining and when it is hurt", async () => {
    const { rules, hooks } = loadGameRules();
    const world = new SimWorld();
    const body = new BodySystem(rules.body, hooks);
    now = 1_000_000;
    gw = new Gateway({ clock: () => now, world, credentialStore: await makeCredentialStore(), systems: [body], body });
    const port = await gw.listen();
    gw.frame(now);
    const tick = (n: number): void => {
      for (let i = 0; i < n; i++) {
        now += 1000 / 30;
        gw!.frame(now);
      }
    };

    const client = new HeadlessClient();
    await client.connect(`ws://127.0.0.1:${port}`);
    const first = client.waitFor(MessageType.Body, 1);
    tick(1); // the avatar's body is made on the first tick it is seen
    const welcome = await client.hello("alice", { username: "alice", password: TEST_PASSWORD });
    tick(6);
    const joined = decodeControl<BodyMessage>((await first)[0]);
    assert.equal(joined.kind, "body");
    assert.equal(joined.entity, welcome.player_entity);
    assert.deepEqual(joined.parts.map((p) => p.id), rules.body.parts.map((p) => p.id));
    assert.ok(joined.parts.every((p) => p.state === "healthy" && p.hp === 1 && !p.bleeding));
    assert.equal(joined.blood, rules.body.blood.max);

    const hurt = client.waitFor(MessageType.Body, 1);
    const eid = world.resolveWireId(BigInt(welcome.player_entity));
    body.applyBlow(world, eid, "legLeft", "cut", 2);
    tick(6);
    const after = decodeControl<BodyMessage>((await hurt)[0]);
    const leg = after.parts.find((p) => p.id === "legLeft")!;
    assert.equal(leg.state, "harmed");
    assert.ok(leg.bleeding);
    assert.ok(leg.hp < 1);
    await client.close();
  });

  it("takes the player's stance, and refuses what the rules don't know (M3)", async () => {
    const { rules, hooks } = loadGameRules();
    const world = new SimWorld();
    const body = new BodySystem(rules.body, hooks);
    const combat = new CombatSystem(30, undefined, { hooks, body, techniques: () => Object.keys(rules.combat.techniques) });
    now = 1_000_000;
    gw = new Gateway({ clock: () => now, world, credentialStore: await makeCredentialStore(), systems: [combat, body], body });
    const port = await gw.listen();
    gw.frame(now);
    const client = new HeadlessClient();
    await client.connect(`ws://127.0.0.1:${port}`);
    const welcome = await client.hello("user-a", { username: "user-a", password: TEST_PASSWORD });
    const avatar = world.resolveWireId(BigInt(welcome.player_entity));
    const error = async (msg: unknown): Promise<ErrorMessage> => {
      const p = client.waitFor(MessageType.Error, 1);
      client.sendRaw(MessageType.Stance, encodeControl(msg));
      return decodeControl<ErrorMessage>((await p)[0]);
    };
    assert.equal((await error({ kind: "stance", technique: "smash" })).code, 4005);
    assert.equal((await error({ kind: "stance", aim: "tail" })).code, 4005);
    assert.equal((await error({ kind: "stance", technique: 3 })).code, 4003);
    client.sendRaw(MessageType.Stance, encodeControl({ kind: "stance", technique: "bludgeon", aim: "head" }));
    const deadline = Date.now() + 2000;
    while (combat.stanceOf(avatar).aim !== "head" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(combat.stanceOf(avatar), { technique: "bludgeon", aim: "head" });
    await client.close();
  });

  it("treats the player's own wound, and says how it goes (M4)", async () => {
    const { rules, hooks } = loadGameRules();
    const world = new SimWorld();
    const sure = { ...hooks, resolveTreatment: (i: Parameters<typeof hooks.resolveTreatment>[0]) => ({ ...hooks.resolveTreatment(i), success: true }) };
    const body = new BodySystem(rules.body, sure);
    now = 1_000_000;
    gw = new Gateway({ clock: () => now, world, credentialStore: await makeCredentialStore(), systems: [body], body });
    const port = await gw.listen();
    gw.frame(now);
    const tick = (n: number): void => {
      for (let i = 0; i < n; i++) {
        now += 1000 / 30;
        gw!.frame(now);
      }
    };
    const client = new HeadlessClient();
    await client.connect(`ws://127.0.0.1:${port}`);
    const welcome = await client.hello("user-a", { username: "user-a", password: TEST_PASSWORD });
    tick(1);
    const me = world.resolveWireId(BigInt(welcome.player_entity));
    const error = async (msg: unknown): Promise<ErrorMessage> => {
      const p = client.waitFor(MessageType.Error, 1);
      client.sendRaw(MessageType.Treat, encodeControl(msg));
      return decodeControl<ErrorMessage>((await p)[0]);
    };
    assert.equal((await error({ kind: "treat" })).message, "nothing there needs treating");
    assert.equal((await error({ kind: "treat", part: "tail" })).code, 4005);
    assert.equal((await error({ kind: "treat", target: "x" })).code, 4003);

    body.applyBlow(world, me, "legLeft", "cut", 2);
    const events = client.waitFor(MessageType.Treat, 2);
    client.sendRaw(MessageType.Treat, encodeControl({ kind: "treat" }));
    const deadline = Date.now() + 2000;
    while (!body.treatingOf(me) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    tick(Math.ceil(rules.body.treatment.bandage.seconds * 30) + 2);
    const [started, done] = (await events).map((b) => decodeControl<TreatmentMessage>(b));
    assert.deepEqual(
      { ...started, seconds: undefined },
      { kind: "treatment", healer: welcome.player_entity, patient: welcome.player_entity, part: "legLeft", treatment: "bandage", state: "started", seconds: undefined },
    );
    assert.equal(started.seconds, rules.body.treatment.bandage.seconds);
    assert.equal(done.state, "done");
    assert.equal(body.view(me).parts.find((p) => p.id === "legLeft")!.bleeding, false);
    await client.close();
  });
});

describe("gateway: skills (M4)", () => {
  it("sends the player's skills, familiarity and disciplines on joining and when they change", async () => {
    const { rules } = loadGameRules();
    const world = new SimWorld();
    const mastery = new MasterySystem(rules.skills, () => 1000, rules.disciplines.disciplines);
    now = 1_000_000;
    gw = new Gateway({ clock: () => now, world, credentialStore: await makeCredentialStore(), systems: [mastery], mastery });
    const port = await gw.listen();
    gw.frame(now);
    const client = new HeadlessClient();
    await client.connect(`ws://127.0.0.1:${port}`);
    const first = client.waitFor(MessageType.Skills, 1);
    const welcome = await client.hello("user-a", { username: "user-a", password: TEST_PASSWORD });
    const joined = decodeControl<SkillsMessage>((await first)[0]);
    assert.equal(joined.max, rules.skills.max);
    assert.deepEqual(joined.skills.map((k) => k.id), rules.skills.skills.map((k) => k.id));
    assert.deepEqual(joined.disciplines, []);
    assert.deepEqual(joined.toward?.map((d) => d.id), rules.disciplines.disciplines.map((d) => d.id), "every discipline is a goal");
    assert.deepEqual(joined.toward?.find((d) => d.id === "bladeMaster")?.requires, [{ skill: "cutting", level: 80 }, { skill: "parrying", level: 70 }]);

    const me = world.resolveWireId(BigInt(welcome.player_entity));
    const sheet = mastery.sheetOf(me);
    for (const [id, level] of Object.entries(rules.disciplines.disciplines.find((d) => d.id === "bladeMaster")!.requires)) {
      sheet.value[mastery.index.of(id)] = level;
      sheet.peak[mastery.index.of(id)] = level;
    }
    sheet.useFamily("sword", 1000);
    const changed = client.waitFor(MessageType.Skills, 1);
    for (let i = 0; i < 31; i++) {
      now += 1000 / 30;
      gw.frame(now);
    }
    const after = decodeControl<SkillsMessage>((await changed)[0]);
    assert.deepEqual(after.disciplines.map((d) => [d.id, d.active, d.unlocks]), [["bladeMaster", true, ["disarm"]]]);
    assert.deepEqual(after.disciplines[0].requires, [{ skill: "cutting", level: 80 }, { skill: "parrying", level: 70 }]);
    assert.equal(after.toward?.some((d) => d.id === "bladeMaster"), false, "no longer a goal");
    assert.deepEqual(after.familiarity, [{ family: "sword", value: rules.skills.familiarity.perUse }]);
    assert.equal(after.skills.find((k) => k.id === "cutting")!.value, 80);
    await client.close();
  });

  it("the admin console sets a skill, peak with it", async () => {
    const { rules } = loadGameRules();
    const world = new SimWorld();
    const mastery = new MasterySystem(rules.skills, () => 1000, rules.disciplines.disciplines);
    now = 1_000_000;
    gw = new Gateway({ clock: () => now, world, credentialStore: await makeCredentialStore(), systems: [mastery], mastery, admins: ["user-a"] });
    const port = await gw.listen();
    gw.frame(now);
    const client = new HeadlessClient();
    await client.connect(`ws://127.0.0.1:${port}`);
    const welcome = await client.hello("user-a", { username: "user-a", password: TEST_PASSWORD });
    const admin = async (args: unknown): Promise<AdminResult> => {
      const p = client.waitFor(MessageType.Admin, 1);
      client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "skill", args }));
      return decodeControl<AdminResult>((await p)[0]);
    };
    const r = await admin({ id: "medicine", value: 120 });
    assert.deepEqual([r.ok, r.message], [true, `medicine ${rules.skills.max}`]);
    const me = world.resolveWireId(BigInt(welcome.player_entity));
    assert.equal(mastery.sheetOf(me).get("medicine"), rules.skills.max);
    // A refused admin command answers as a 4003 error.
    const badP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "skill", args: { id: "juggling", value: 1 } }));
    assert.match(decodeControl<ErrorMessage>((await badP)[0]).message, /no skill "juggling"/);
    await client.close();
  });
});


describe("gateway: magic", () => {
  it("sends the player's mana, casts Mend, and says how it goes", async () => {
    const { rules } = loadGameRules();
    const world = new SimWorld();
    const magic = new MagicSystem(rules.spells);
    const mend = rules.spells.spells.find((s) => s.id === "mend")!;
    now = 1_000_000;
    gw = new Gateway({ clock: () => now, world, credentialStore: await makeCredentialStore(), systems: [magic], magic });
    const port = await gw.listen();
    gw.frame(now);
    const tick = (n: number): void => {
      for (let i = 0; i < n; i++) {
        now += 1000 / 30;
        gw!.frame(now);
      }
    };
    const client = new HeadlessClient();
    await client.connect(`ws://127.0.0.1:${port}`);
    const first = client.waitFor(MessageType.Magic, 1);
    const welcome = await client.hello("user-a", { username: "user-a", password: TEST_PASSWORD });
    assert.deepEqual(decodeControl<ManaMessage>((await first)[0]), { kind: "mana", current: rules.spells.defaultMax, max: rules.spells.defaultMax });

    const error = async (msg: unknown): Promise<ErrorMessage> => {
      const p = client.waitFor(MessageType.Error, 1);
      client.sendRaw(MessageType.Magic, encodeControl(msg));
      return decodeControl<ErrorMessage>((await p)[0]);
    };
    assert.equal((await error({ kind: "cast", spell: "fireball" })).code, 4005);
    assert.equal((await error({ kind: "cast" })).code, 4003);

    const me = world.resolveWireId(BigInt(welcome.player_entity));
    C.Health.current[me] = 40;
    const events = client.waitFor(MessageType.Magic, 3);
    client.sendRaw(MessageType.Magic, encodeControl({ kind: "cast", spell: "mend" }));
    const deadline = Date.now() + 2000;
    while (!magic.castingOf(me) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    tick(Math.ceil(mend.castSeconds * 30) + 7);
    const msgs = (await events).map((b) => decodeControl<SpellMessage | ManaMessage>(b));
    const spells = msgs.filter((m): m is SpellMessage => m.kind === "spell");
    assert.deepEqual(spells.map((m) => m.state), ["started", "done"]);
    assert.equal(spells[1].amount, mend.effect.amount);
    const mana = msgs.find((m): m is ManaMessage => m.kind === "mana")!;
    assert.equal(mana.current, rules.spells.defaultMax - mend.mana);
    await client.close();
  });
});
