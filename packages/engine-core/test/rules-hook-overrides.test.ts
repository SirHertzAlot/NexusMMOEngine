/**
 * Game hooks (the code seam): a game supplies hook overrides beside its
 * rules, without editing engine source, and they survive a hot reload.
 *
 * The last test here is the regression guard. The overrides argument of
 * `createHooks` existed for a long time while nothing reached it, because
 * the server called `loadGameRules` with no second argument and the
 * reloader did the same. These tests fail if that happens again.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RulesError } from "@mmo-engine/rules";
import { SimWorld } from "../src/world.js";
import { DEFAULT_RULES_DIR, loadGameRules, openGameRules, type GameRules } from "../src/rules/boot.js";
import { HOOKS_ENV, loadHooks, resolveHooksFile, validateHookOverrides } from "../src/rules/hook-overrides.js";
import { RulesReloader } from "../src/rules/reload.js";

let dir = "";
const hooksFile = (): string => path.join(dir, "hooks.mjs");
const writeHooks = (body: string): void => fs.writeFileSync(hooksFile(), body);
const clearHooks = (): void => fs.rmSync(hooksFile(), { force: true });

/** A blow whose damage the engine's own `computeDamage` decides. */
const BLOW = {
  technique: "cut",
  skill: 0.5,
  item: { mass: 1.2, edge: 0.8, point: 0.2, hardness: 0.7 },
  part: "torso",
  armourFactor: 1,
} as const;

/** Each loaded module is cached by URL, so every hooks file needs its own name. */
let nonce = 0;
const uniqueHooks = (body: string): string => {
  const file = path.join(dir, `hooks-${++nonce}.mjs`);
  fs.writeFileSync(file, body);
  return file;
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-hooks-"));
  fs.cpSync(DEFAULT_RULES_DIR, dir, { recursive: true });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("resolveHooksFile", () => {
  it("finds hooks.mjs beside the rules, and nothing when there is none", () => {
    clearHooks();
    assert.equal(resolveHooksFile(dir, {}), null);
    writeHooks("export default {};\n");
    assert.equal(resolveHooksFile(dir, {}), hooksFile());
    clearHooks();
  });

  it("takes the file the environment names, over one in the rules folder", () => {
    writeHooks("export default {};\n");
    const named = uniqueHooks("export default {};\n");
    assert.equal(resolveHooksFile(dir, { [HOOKS_ENV]: named }), named);
    clearHooks();
  });

  it("MMO_RULES_HOOKS=0 runs the engine's own defaults, hooks file or not", () => {
    writeHooks("export default {};\n");
    assert.equal(resolveHooksFile(dir, { [HOOKS_ENV]: "0" }), null);
    clearHooks();
  });

  it("refuses to boot quietly when the named file is missing", () => {
    assert.throws(
      () => resolveHooksFile(dir, { [HOOKS_ENV]: path.join(dir, "absent.mjs") }),
      (err: unknown) => err instanceof RulesError && /hooks file not found/.test((err as Error).message),
    );
  });
});

describe("validateHookOverrides", () => {
  it("names a hook that does not exist, listing the ones that do", () => {
    assert.throws(
      () => validateHookOverrides({ computeDmg: () => 0 }, "hooks.mjs"),
      (err: unknown) =>
        err instanceof RulesError &&
        /computeDmg: not a hook/.test((err as Error).message) &&
        /computeDamage/.test((err as Error).message),
    );
  });

  it("refuses a hook that is not a function, and a module that is not an object", () => {
    assert.throws(() => validateHookOverrides({ onDeath: 3 }, "hooks.mjs"), RulesError);
    assert.throws(() => validateHookOverrides([], "hooks.mjs"), RulesError);
    assert.throws(() => validateHookOverrides(null, "hooks.mjs"), RulesError);
  });

  it("accepts the hooks the SDK knows", () => {
    const ok = { computeDamage: (i: unknown, base: (i: unknown) => unknown) => base(i) };
    assert.equal(validateHookOverrides(ok, "hooks.mjs"), ok);
  });
});

describe("a game's hooks reach the engine", () => {
  it("replaces a hook, and the replacement is handed the engine default", async () => {
    const plain = loadGameRules(dir);
    const file = uniqueHooks(
      "export default { computeDamage: (input, base) => ({ ...base(input), amount: base(input).amount * 2 }) };\n",
    );
    const source = await openGameRules(dir, { [HOOKS_ENV]: file });
    const game = source.load();
    assert.deepEqual(game.overrides, ["computeDamage"]);
    assert.match(game.summary, /hooks: computeDamage/);
    const before = plain.hooks.computeDamage(BLOW).amount;
    assert.ok(before > 0, "the engine default does something to compare against");
    assert.equal(game.hooks.computeDamage(BLOW).amount, before * 2);
    // Hooks it did not name keep the engine's behaviour.
    assert.deepEqual(game.hooks.onDeath({ cause: "other" }), plain.hooks.onDeath({ cause: "other" }));
  });

  it("takes a factory, handed the rules it will run against", async () => {
    const file = uniqueHooks(
      "export default (rules) => ({ skillGain: (input, base) => base(input) + rules.body.parts.length });\n",
    );
    const source = await openGameRules(dir, { [HOOKS_ENV]: file });
    const game = source.load();
    const plain = loadGameRules(dir);
    const input = { skill: 0.2, peak: 0.3, difficulty: 0.5 };
    assert.equal(game.hooks.skillGain(input), plain.hooks.skillGain(input) + plain.rules.body.parts.length);
  });

  it("stops the boot on a hooks file that names a hook wrong", async () => {
    const file = uniqueHooks("export default { computeDmage: () => 0 };\n");
    await assert.rejects(() => openGameRules(dir, { [HOOKS_ENV]: file }), RulesError);
  });

  it("stops the boot on a hooks file that will not load", async () => {
    const file = uniqueHooks("export default { computeDamage: ( => };\n");
    await assert.rejects(() => openGameRules(dir, { [HOOKS_ENV]: file }), RulesError);
  });

  it("runs the engine's defaults when the game has no hooks file", async () => {
    clearHooks();
    const source = await openGameRules(dir, {});
    assert.equal(source.hooksFile, null);
    const game = source.load();
    assert.deepEqual(game.overrides, []);
    assert.doesNotMatch(game.summary, /hooks:/);
  });
});

describe("a hot reload keeps the game's hooks", () => {
  it("reloads through the rules source, so overrides are still applied", async () => {
    const file = uniqueHooks(
      "export default { computeDamage: (input, base) => ({ ...base(input), amount: base(input).amount * 3 }) };\n",
    );
    const source = await openGameRules(dir, { [HOOKS_ENV]: file });
    const applied: GameRules[] = [];
    const reloader = new RulesReloader(dir, (g) => applied.push(g), { source });

    // An edit to the rules the way the editor saves one.
    const loot = fs.readFileSync(path.join(dir, "loot.json"), "utf8");
    fs.writeFileSync(path.join(dir, "loot.json"), JSON.stringify({ ...JSON.parse(loot), pickupRange: 5 }, null, 2));
    assert.equal(reloader.reload(), true);
    reloader.step(new SimWorld(), 1 / 30);
    fs.writeFileSync(path.join(dir, "loot.json"), loot);
    reloader.close();

    assert.equal(applied.length, 1);
    const reloaded = applied[0];
    assert.equal(reloaded.rules.loot.pickupRange, 5, "the reload really did take the new rules");
    const plain = loadGameRules(dir).hooks.computeDamage(BLOW).amount;
    assert.equal(
      reloaded.hooks.computeDamage(BLOW).amount,
      plain * 3,
      "a reload must not drop the game back to the engine's own hooks",
    );
  });

  it("re-runs a factory against the reloaded rules", async () => {
    const file = uniqueHooks(
      "export default (rules) => ({ skillGain: (input, base) => base(input) + rules.loot.pickupRange });\n",
    );
    const source = await openGameRules(dir, { [HOOKS_ENV]: file });
    const loot = fs.readFileSync(path.join(dir, "loot.json"), "utf8");
    fs.writeFileSync(path.join(dir, "loot.json"), JSON.stringify({ ...JSON.parse(loot), pickupRange: 7 }, null, 2));
    const applied: GameRules[] = [];
    const reloader = new RulesReloader(dir, (g) => applied.push(g), { source });
    assert.equal(reloader.reload(), true);
    reloader.step(new SimWorld(), 1 / 30);
    fs.writeFileSync(path.join(dir, "loot.json"), loot);
    reloader.close();

    const input = { skill: 0.2, peak: 0.3, difficulty: 0.5 };
    const base = loadGameRules(dir).hooks.skillGain(input);
    assert.equal(applied[0].hooks.skillGain(input), base + 7, "the factory saw the rules as they are now");
  });

  it("a reloader given no source still loads, on the engine's own hooks", async () => {
    const applied: GameRules[] = [];
    const reloader = new RulesReloader(dir, (g) => applied.push(g));
    assert.equal(reloader.reload(), true);
    reloader.step(new SimWorld(), 1 / 30);
    reloader.close();
    assert.deepEqual(applied[0].overrides, []);
  });
});

describe("the server keeps the seam wired", () => {
  // A source check, because booting a whole server for it would be far
  // slower than the thing it guards: that the two call sites keep passing
  // the game's hooks on. Both went missing once already.
  const serverSrc = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/server.ts"),
    "utf8",
  );

  it("boots the rules through openGameRules, not bare loadGameRules", () => {
    assert.match(serverSrc, /await openGameRules\(/, "server.ts must open the rules with their hooks");
    assert.doesNotMatch(
      serverSrc,
      /\bloadGameRules\(/,
      "server.ts must not load the rules without the game's hooks; use rulesSource.load()",
    );
  });

  it("hands the rules source to the reloader", () => {
    assert.match(
      serverSrc,
      /new RulesReloader\([\s\S]*?\{\s*source:\s*rulesSource\s*\}\)/,
      "the reloader must take the rules source, or a reload drops the game's hooks",
    );
  });
});
