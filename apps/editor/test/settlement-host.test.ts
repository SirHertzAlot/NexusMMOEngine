/**
 * The town rules host: reads content/settlements/rules.json (the built-in rules when absent), saves only a
 * clean file (schema and archetype names, per path), and previews a town from unsaved rules. Writes go to a
 * throwaway repo root, never the real content/settlements.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_RULES } from "@mmo-engine/settlement";
import { handleSettlementRoute, previewSettlement, readSettlementRules, saveSettlementRules, settlementRulesFile } from "../src/settlement-host.js";

// dist/test/<name>.test.js → repo root.
const REPO = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "mmo-town-rules-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("readSettlementRules", () => {
  it("reads the repo's rules file", () => {
    const { content, missing } = readSettlementRules(REPO);
    assert.equal(missing, false);
    assert.equal((content as { version: string }).version, BUILTIN_RULES.version);
  });
  it("shows the built-in rules when there is no file", () => {
    withRoot((root) => assert.deepEqual(readSettlementRules(root), { content: BUILTIN_RULES, missing: true }));
  });
});

describe("saveSettlementRules", () => {
  it("writes a clean file pretty-printed", () => {
    withRoot((root) => {
      const rules = clone(BUILTIN_RULES);
      rules.industry!.resources!.perWorkplace = 5;
      saveSettlementRules(root, rules);
      const text = readFileSync(settlementRulesFile(root), "utf8");
      assert.equal(text, `${JSON.stringify(rules, null, 2)}\n`);
    });
  });
  it("writes nothing and names each problem by path", () => {
    withRoot((root) => {
      const rules = clone(BUILTIN_RULES);
      rules.industry!.guild!.archetype = "guildhall";
      assert.throws(
        () => saveSettlementRules(root, rules),
        (e: unknown) => {
          const err = e as { status?: number; issues?: { file: string; path: string; message: string }[] };
          return err.status === 400 && err.issues?.length === 1 && err.issues[0]!.path === "industry.guild.archetype" && err.issues[0]!.file === "settlements/rules.json";
        },
      );
      const bad = clone(BUILTIN_RULES) as unknown as { layout: { block: unknown[] } };
      bad.layout.block = [3, -1];
      assert.throws(() => saveSettlementRules(root, bad), (e: unknown) => (e as { issues?: { path: string }[] }).issues?.some((i) => i.path === "layout.block[1]") === true);
      assert.equal(existsSync(settlementRulesFile(root)), false);
    });
  });
});

describe("previewSettlement", () => {
  it("builds a forest town with its industry, guild and tree stands, from unsaved rules", async () => {
    const rules = clone(BUILTIN_RULES);
    rules.industry!.resources!.nodes.timber!.stock = 7;
    const p = await previewSettlement(rules, 1000, 1, "forest");
    assert.ok(p.ok, JSON.stringify(p));
    assert.equal(p.industry?.primary, "timber");
    assert.ok(p.guild && p.guild.ranks.length > 0);
    const stands = p.resources.filter((r) => r.kind === "tree_stand");
    assert.ok(stands.length > 0);
    assert.ok(stands.every((r) => r.stock <= r.nodes * 7));
    assert.equal(p.plan.parcels.length > 0 && p.structures > 0, true);
    assert.deepEqual(p.gates.failed, []);
  });
  it("gives a town without land no industry", async () => {
    const p = await previewSettlement(BUILTIN_RULES, 600, 1, "none");
    assert.ok(p.ok);
    assert.equal(p.industry, null);
    assert.deepEqual(p.resources, []);
  });
  it("answers invalid rules with their problems, not a town", async () => {
    const rules = clone(BUILTIN_RULES);
    rules.watch!.gaol = "goal";
    const p = await previewSettlement(rules, 600, 1, "none");
    assert.equal(p.ok, false);
    assert.deepEqual(!p.ok && p.issues?.map((i) => i.path), ["watch.gaol"]);
  });
});

describe("handleSettlementRoute", () => {
  it("routes only its own paths and refuses bad bodies", async () => {
    assert.equal(await handleSettlementRoute(REPO, "GET", "/api/editor/scale", undefined), null);
    assert.equal((await handleSettlementRoute(REPO, "GET", "/api/editor/settlements/nope", undefined))?.status, 404);
    assert.equal((await handleSettlementRoute(REPO, "PUT", "/api/editor/settlements/rules", "{"))?.status, 400);
    assert.equal((await handleSettlementRoute(REPO, "POST", "/api/editor/settlements/preview", JSON.stringify({ content: {}, population: 10, seed: 1, land: "moon" })))?.status, 400);
    const ok = await handleSettlementRoute(REPO, "POST", "/api/editor/settlements/preview", JSON.stringify({ content: BUILTIN_RULES, population: 300, seed: 2, land: "coast" }));
    assert.equal(ok?.status, 200);
    assert.equal((ok?.body as { ok: boolean }).ok, true);
  });
});
