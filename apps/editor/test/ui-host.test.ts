/** HUD layout and string tables: content/ui/hud.json and content/strings/<lang>.json, validated saves, refused saves write nothing. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textHash, type HudDoc, type StringsBundle } from "@mmo-engine/scene";
import { handleUiRoute, scanClientStrings } from "../src/ui-host.js";

const HUD: HudDoc = {
  version: 1,
  theme: { card: "#101010" },
  widgets: { chat: { anchor: "bottom", x: 0, y: 16, w: 400, h: 200 }, settings: { anchor: "top-right", x: 16, y: 16, w: 200, h: 40 } },
};
const EN: StringsBundle = { version: 1, lang: "en", messages: { "a.one": "One {n}", "a.two": "Two", "a.unused": "Never used" } };

function fakeRepo(): string {
  const root = join(tmpdir(), `mmo-ui-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  mkdirSync(join(root, "content", "ui"), { recursive: true });
  mkdirSync(join(root, "content", "strings"), { recursive: true });
  mkdirSync(join(root, "apps", "client", "src", "ui"), { recursive: true });
  mkdirSync(join(root, "apps", "client", "test"), { recursive: true });
  writeFileSync(join(root, "content", "ui", "hud.json"), JSON.stringify(HUD));
  writeFileSync(join(root, "content", "strings", "en.json"), JSON.stringify(EN));
  writeFileSync(join(root, "apps", "client", "src", "ui", "x.tsx"), 'export const a = t("a.one", { n: 1 }); const b = t("a.two"); const c = t("a.missing"); const d = t(`dyn.${k}`);\n');
  writeFileSync(join(root, "apps", "client", "test", "y.test.ts"), 't("test.only")');
  return root;
}
const get = (root: string, path: string) => handleUiRoute(root, "GET", path, undefined);
const put = (root: string, path: string, content: unknown) => handleUiRoute(root, "PUT", path, JSON.stringify({ content }));

describe("ui routes", () => {
  it("ignores other paths", () => {
    assert.equal(handleUiRoute("x", "GET", "/api/editor/flow", undefined), null);
  });

  it("HUD: GET returns the document with the widget catalog", () => {
    const root = fakeRepo();
    const r = get(root, "/api/editor/hud");
    const b = r?.body as { content: HudDoc; catalog: { id: string }[] };
    assert.equal(r?.status, 200);
    assert.deepEqual(b.content, HUD);
    assert.ok(b.catalog.some((c) => c.id === "player-frame"));
    rmSync(root, { recursive: true });
  });
  it("HUD: saves a valid layout; a refused one answers 400 and writes nothing", () => {
    const root = fakeRepo();
    const file = join(root, "content", "ui", "hud.json");
    const next: HudDoc = { ...HUD, widgets: { ...HUD.widgets, chat: { ...HUD.widgets.chat, x: 40 } } };
    assert.equal(put(root, "/api/editor/hud", next)?.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), next);
    const before = readFileSync(file, "utf8");
    const bad = put(root, "/api/editor/hud", { ...HUD, widgets: { ghost: HUD.widgets.chat } });
    assert.equal(bad?.status, 400);
    assert.ok((bad?.body as { issues: { path: string }[] }).issues.some((i) => i.path === "widgets.ghost"));
    assert.equal(handleUiRoute(root, "PUT", "/api/editor/hud", "not json")?.status, 400);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.deepEqual(readdirSync(join(root, "content", "ui")), ["hud.json"]);
    rmSync(root, { recursive: true });
  });

  it("scans the client's sources for t() ids, not its tests", () => {
    const root = fakeRepo();
    const s = scanClientStrings(root);
    assert.deepEqual(s.ids, { "a.one": ["ui/x.tsx"], "a.two": ["ui/x.tsx"], "a.missing": ["ui/x.tsx"] });
    assert.deepEqual(s.prefixes, ["dyn."]);
    rmSync(root, { recursive: true });
  });
  it("Strings: GET lists languages with status and what extraction finds", () => {
    const root = fakeRepo();
    writeFileSync(
      join(root, "content", "strings", "fr.json"),
      JSON.stringify({ version: 1, lang: "fr", messages: { "a.two": "Deux", "z.extra": "x" }, source: { "a.two": textHash("Old two") } }),
    );
    const r = get(root, "/api/editor/strings");
    const b = r?.body as {
      langs: Record<string, StringsBundle>;
      status: Record<string, { rows: { id: string; status: string }[]; extra: string[] }>;
      missingInSource: string[];
      unused: string[];
    };
    assert.equal(r?.status, 200);
    assert.deepEqual(Object.keys(b.langs).sort(), ["en", "fr"]);
    assert.equal(b.status.fr.rows.find((x) => x.id === "a.two")?.status, "stale");
    assert.equal(b.status.fr.rows.find((x) => x.id === "a.one")?.status, "missing");
    assert.deepEqual(b.status.fr.extra, ["z.extra"]);
    assert.deepEqual(b.missingInSource, ["a.missing"]);
    assert.deepEqual(b.unused, ["a.unused"]);
    rmSync(root, { recursive: true });
  });
  it("Strings: saves a language, creating a new one; refuses what is invalid and writes nothing", () => {
    const root = fakeRepo();
    const dir = join(root, "content", "strings");
    const de: StringsBundle = { version: 1, lang: "de", messages: { "a.two": "Zwei" } };
    assert.equal(put(root, "/api/editor/strings/de", de)?.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "de.json"), "utf8")), de);
    assert.equal(put(root, "/api/editor/strings/en", { ...EN, messages: { ...EN.messages, "a.two": "Two!" } })?.status, 200);
    const before = readdirSync(dir).sort();
    for (const [path, body] of [
      ["/api/editor/strings/pseudo", de],
      ["/api/editor/strings/..%2Fx", de],
      ["/api/editor/strings/DE", de],
      ["/api/editor/strings/de", { ...de, lang: "fr" }],
      ["/api/editor/strings/de", { ...de, messages: { "a.two": "{broken" } }],
      ["/api/editor/strings/de", { ...de, messages: { "Bad Id": "x" } }],
    ] as const) {
      const r = put(root, path, body);
      assert.ok(r && r.status >= 400, path);
    }
    assert.deepEqual(readdirSync(dir).sort(), before);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "de.json"), "utf8")), de);
    rmSync(root, { recursive: true });
  });
  it("Strings: English is the source and cannot be removed; only listed methods exist", () => {
    const root = fakeRepo();
    assert.equal(handleUiRoute(root, "DELETE", "/api/editor/strings/en", undefined)?.status, 404);
    assert.equal(get(root, "/api/editor/strings/en")?.status, 404);
    rmSync(root, { recursive: true });
  });
});
