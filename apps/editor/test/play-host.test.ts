/**
 * play-host: the saved setups document (content/play/setups.json): validation,
 * the loopback route, and that a refused save writes nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptySetups, handlePlaySetupsRoute, setupsFile, validateSetupsDoc } from "../src/play-host.js";
import { defaultPlaySetup } from "../src/ui/play-setup.js";

const good = { version: 1, setups: [{ name: "Raid", shortcut: "F6", setup: { ...defaultPlaySetup(), clients: "8", from: "character-select" } }] };

describe("play setups document", () => {
  it("accepts a valid document and the empty one", () => {
    assert.deepEqual(validateSetupsDoc(good), []);
    assert.deepEqual(validateSetupsDoc(emptySetups()), []);
  });

  it("lists every problem", () => {
    const bad = {
      version: 1,
      setups: [
        { name: "", setup: defaultPlaySetup() },
        { name: "A", shortcut: "F6", setup: { ...defaultPlaySetup(), clients: "9" } },
        { name: "A", shortcut: "F6", setup: defaultPlaySetup() },
        { name: "B", shortcut: "F5", setup: defaultPlaySetup() },
      ],
    };
    const issues = validateSetupsDoc(bad);
    assert.ok(issues.some((i) => i.startsWith("setups[0]: name")), issues.join("|"));
    assert.ok(issues.some((i) => i.startsWith("setups[1].setup.clients")), issues.join("|"));
    assert.ok(issues.some((i) => i.includes('duplicate name "A"')), issues.join("|"));
    assert.ok(issues.some((i) => i.startsWith("setups[3]: shortcut")), issues.join("|"));
    assert.deepEqual(validateSetupsDoc({ version: 2, setups: [] }), ["version must be 1"]);
  });

  it("the route reads an absent file as empty, saves a valid document and refuses an invalid one without writing", () => {
    const root = mkdtempSync(join(tmpdir(), "play-setups-"));
    try {
      const url = "/api/editor/play/setups";
      assert.deepEqual(handlePlaySetupsRoute(root, "GET", url, undefined)?.body, { ok: true, content: emptySetups() });
      const bad = JSON.stringify({ content: { version: 1, setups: [{ name: "x", setup: { ...defaultPlaySetup(), bots: "x" } }] } });
      assert.equal(handlePlaySetupsRoute(root, "PUT", url, bad)?.status, 400);
      assert.equal(existsSync(setupsFile(root)), false, "a refused save writes nothing");
      assert.equal(handlePlaySetupsRoute(root, "PUT", url, JSON.stringify({ content: good }))?.status, 200);
      assert.deepEqual(JSON.parse(readFileSync(setupsFile(root), "utf8")), good);
      assert.deepEqual(handlePlaySetupsRoute(root, "GET", url, undefined)?.body, { ok: true, content: good });
      assert.equal(handlePlaySetupsRoute(root, "PUT", url, "{nope")?.status, 400);
      assert.equal(handlePlaySetupsRoute(root, "GET", "/api/editor/other", undefined), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
