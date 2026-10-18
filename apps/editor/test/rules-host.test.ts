/**
 * Rules host storage: whitelisted file names (no traversal), paths
 * confined to content/rules, pretty-printed write-back, and save
 * validation through the rules package's parse API (schema errors per
 * path plus cross-file checks). Writes go to a throwaway repo root —
 * never the real content/rules.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRuleSave,
  isRuleFile,
  prettyPrintRules,
  readRuleFile,
  resolveRulePath,
  ruleFileNames,
  saveRuleFile,
} from "../src/rules-host.js";

// dist/test/<name>.test.js → repo root (four levels up from the built test file).
const REPO = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));

function fakeRepo(): string {
  const root = join(tmpdir(), `mmo-rules-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  mkdirSync(join(root, "content", "rules"), { recursive: true });
  return root;
}

function copyReal(root: string, name: string): void {
  writeFileSync(
    join(root, "content", "rules", `${name}.json`),
    readFileSync(join(REPO, "content", "rules", `${name}.json`), "utf8"),
  );
}

describe("ruleFileNames", () => {
  it("lists every content/rules/*.json in schema order", () => {
    assert.deepEqual(ruleFileNames(), [
      "skills",
      "disciplines",
      "combat",
      "body",
      "death",
      "appearance",
      "stats",
      "items",
      "loot",
      "creatures",
      "needs",
      "ingress",
      "spells",
      "gathering",
      "movement",
      "social",
    ]);
  });
});

describe("isRuleFile", () => {
  it("accepts whitelisted names", () => {
    assert.equal(isRuleFile("loot"), true);
    assert.equal(isRuleFile("skills"), true);
  });
  it("rejects traversal, extensions, case and empties", () => {
    for (const n of ["", "../server", "..", "loot.json", "loot/", "loot\\x", "SKILLS", "loot ", "rules", "server"]) {
      assert.equal(isRuleFile(n), false, n);
    }
  });
});

describe("resolveRulePath", () => {
  it("stays inside content/rules", () => {
    const p = resolveRulePath(REPO, "loot");
    assert.equal(p, join(REPO, "content", "rules", "loot.json"));
  });
  it("404s unknown and traversal names", () => {
    for (const n of ["nope", "../server", "loot.json", ""]) {
      assert.throws(() => resolveRulePath(REPO, n), (e: unknown) => (e as { status?: number }).status === 404, n);
    }
  });
});

describe("prettyPrintRules", () => {
  it("uses 2 spaces, keeps key order, ends with a newline", () => {
    const out = prettyPrintRules({ b: 1, a: { y: [1, 2], x: true } });
    assert.equal(out, `{\n  "b": 1,\n  "a": {\n    "y": [\n      1,\n      2\n    ],\n    "x": true\n  }\n}\n`);
  });
});

describe("checkRuleSave", () => {
  it("accepts a valid tweak", () => {
    const root = fakeRepo();
    try {
      const issues = checkRuleSave(root, "loot", {
        ownershipSeconds: 31,
        despawnSeconds: 300,
        pickupRange: 2.5,
        bagSlots: 24,
        maxGroundItems: 4096,
      });
      assert.deepEqual(issues, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("reports schema problems per path", () => {
    const root = fakeRepo();
    try {
      const issues = checkRuleSave(root, "loot", { ownershipSeconds: -1, ratePerWeak: 2 });
      const paths = issues.map((i) => `${i.file}:${i.path}`);
      assert.ok(paths.includes("loot.json:ownershipSeconds"), JSON.stringify(paths));
      assert.ok(
        paths.some((p) => p.startsWith("loot.json:")),
        JSON.stringify(paths),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("runs single-file cross-checks (body shares must add to 1)", () => {
    const root = fakeRepo();
    try {
      const issues = checkRuleSave(root, "body", {
        parts: [{ id: "body", name: "Body", parent: null, share: 0.5 }],
      });
      assert.ok(
        issues.some((i) => i.file === "body.json" && i.path === "parts" && /0\.500/.test(i.message)),
        JSON.stringify(issues),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("runs cross-file checks against the on-disk siblings", () => {
    const root = fakeRepo();
    try {
      // combat.json (real) points technique "cut" at skill "cutting";
      // saving a skills file without that skill must fail.
      copyReal(root, "combat");
      const issues = checkRuleSave(root, "skills", { skills: [] });
      assert.ok(
        issues.some(
          (i) => i.file === "combat.json" && i.path === "techniques.cut.skill" && /no skill "cutting"/.test(i.message),
        ),
        JSON.stringify(issues),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readRuleFile", () => {
  it("reads the real loot file", () => {
    const { content, missing } = readRuleFile(REPO, "loot");
    assert.equal(missing, false);
    assert.equal((content as { bagSlots: number }).bagSlots, 24);
  });
  it("falls back to engine defaults when the file is missing", () => {
    const root = fakeRepo();
    try {
      const { content, missing } = readRuleFile(root, "loot");
      assert.equal(missing, true);
      assert.equal((content as { bagSlots: number }).bagSlots, 24);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("saveRuleFile", () => {
  it("writes pretty-printed JSON only when valid", () => {
    const root = fakeRepo();
    try {
      saveRuleFile(root, "loot", { pickupRange: 3, bagSlots: 24 });
      const text = readFileSync(join(root, "content", "rules", "loot.json"), "utf8");
      assert.equal(text, `{\n  "pickupRange": 3,\n  "bagSlots": 24\n}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("writes nothing when invalid, with per-path issues on the error", () => {
    const root = fakeRepo();
    try {
      assert.throws(
        () => saveRuleFile(root, "loot", { ownershipSeconds: -1 }),
        (e: unknown) => {
          const err = e as { status?: number; issues?: Array<{ file: string; path: string }> };
          return (
            err.status === 400 &&
            Array.isArray(err.issues) &&
            err.issues.some((i) => i.file === "loot.json" && i.path === "ownershipSeconds")
          );
        },
      );
      assert.equal(existsSync(join(root, "content", "rules", "loot.json")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
