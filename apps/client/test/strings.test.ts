import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PSEUDO_LANG, type StringsBundle } from "@mmo-engine/scene";
import { createT, pickLang } from "../src/i18n-core.js";
import { en } from "./strings-setup.js";
import { ACTIONS, ACTION_LABELS, FIXED_MOUSE } from "../src/input/bindings.js";
import { AUDIO_BUSES, BUS_LABELS } from "../src/audio/volumes.js";

// dist/test -> apps/client/src
const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") ? [join(dir, e.name)] : []));
const source = files(SRC).map((f) => ({ f: f.slice(SRC.length + 1).replace(/\\/g, "/"), text: readFileSync(f, "utf8").replace(/\r\n/g, "\n") }));
const all = source.map((s) => s.text).join("\n");

describe("t()", () => {
  const fr: StringsBundle = { version: 1, lang: "fr", messages: { "bag.title": "sac" } };
  const bundles = { en, fr };
  it("falls back to English, then to the id", () => {
    assert.equal(createT(bundles, "fr")("bag.title"), "sac");
    assert.equal(createT(bundles, "fr")("bag.drop"), "drop");
    assert.equal(createT(bundles, "fr")("no.such.id"), "no.such.id");
  });
  it("formats ICU arguments", () => {
    assert.equal(createT(bundles, "en")("dungeon.loot", { n: 1 }), "1 item waiting in your bag.");
    assert.equal(createT(bundles, "en")("dungeon.loot", { n: 3 }), "3 items waiting in your bag.");
  });
  it("the pseudo-locale accents every letter of the source", () => {
    const p = createT(bundles, PSEUDO_LANG)("bag.drop");
    assert.match(p, /^\[.*\]$/);
    assert.ok(!/[a-z]/.test(p.replace(/~/g, "")), p);
  });
  it("picks ?lang= over the stored choice over the browser", () => {
    assert.equal(pickLang(["en", "fr"], "?lang=fr", "en", ["en"]), "fr");
    assert.equal(pickLang(["en", "fr"], "", "fr", ["en"]), "fr");
    assert.equal(pickLang(["en", "fr"], "", null, ["de-DE", "fr-CA"]), "fr");
    assert.equal(pickLang(["en", "fr"], "?lang=pseudo", null, []), PSEUDO_LANG);
    assert.equal(pickLang(["en", "fr"], "?lang=xx", null, []), "en");
  });
});

describe("the client's strings", () => {
  const ids = Object.keys(en.messages);
  const dyn = [...all.matchAll(/\bt\(\s*`([a-z][A-Za-z0-9.-]*\.)\$\{/g)].map((m) => m[1]);
  it("every t(\"id\") names a message in en.json", () => {
    const used = [...all.matchAll(/\bt\(\s*"([a-z][A-Za-z0-9.-]*)"/g)].map((m) => m[1]);
    assert.ok(used.length > 100, `only ${used.length} t() calls`);
    assert.deepEqual(used.filter((id) => !(id in en.messages)), []);
    for (const p of dyn) assert.ok(ids.some((id) => id.startsWith(p)), `no message under ${p}`);
  });
  it("every message is used: by a literal id, or under a computed prefix", () => {
    const unused = ids.filter((id) => !all.includes(`"${id}"`) && !dyn.some((p) => id.startsWith(p)));
    assert.deepEqual(unused, []);
  });
  it("covers the key labels and the audio buses", () => {
    for (const a of ACTIONS) assert.equal(en.messages[`action.${a}`], ACTION_LABELS[a]);
    for (const b of AUDIO_BUSES) assert.equal(en.messages[`bus.${b}`], BUS_LABELS[b]);
    for (const m of FIXED_MOUSE) assert.equal(en.messages[`mouse.${m.code}`], m.label);
  });
  it("every ICU message parses (the scene package checks the syntax; this guards the file)", () => {
    const t = createT({ en }, "en");
    for (const id of ids) assert.doesNotThrow(() => t(id, {}), id);
  });
});

/**
 * Player-facing files: no JSX text and no title/aria-label/placeholder left in a
 * language. Developer tools (the debug panels, perf HUD, admin console, the
 * character preview page) show developer text and are not translated.
 */
const DEV = new Set(["ui/dev-panels.tsx", "ui/perf-hud.tsx", "ui/admin-console.tsx", "ui/character-preview.tsx", "ui/debug.ts", "ui/components.tsx", "main.tsx"]);
const GLYPH = /^[^A-Za-z]*$/;
function hardcoded(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const hits: string[] = [];
  for (const m of code.matchAll(/>([^<>{}=;]*[A-Za-z]{2}[^<>{}=;]*)</g)) if (!GLYPH.test(m[1].trim()) && !/[)\]:,]|^\s*$|^\s*(Promise|Array|Record|Set|Map|Extract)\s*$/.test(m[1])) hits.push(m[1].trim());
  for (const m of code.matchAll(/\b(?:title|aria-label|placeholder|alt)="([^"{}]*[A-Za-z]{2}[^"{}]*)"/g)) if (!m[1].includes("://")) hits.push(m[1]);
  // text next to an expression: >casting {x}  and  {x} s<
  for (const m of code.matchAll(/>\s*([A-Za-z][A-Za-z ,.'!?-]*[A-Za-z])\s*\{|\}\s*([A-Za-z][A-Za-z ,.'!?-]*[A-Za-z])\s*</g)) hits.push((m[1] ?? m[2]).trim());
  // bare JSX text lines: a line of words alone, inside a tag
  for (const m of code.matchAll(/^\s+([A-Za-z][A-Za-z ,.'!?:·…-]*[A-Za-z.!?…])$/gm)) {
    if (!/^(return|else|default|case|break|continue|const|let|var|import|export|type|interface|function|async|await|throw|null|true|false|void|new|if|for|while|switch)\b/.test(m[1])) hits.push(m[1]);
  }
  return hits;
}
describe("no hard-coded player text", () => {
  for (const { f, text } of source) {
    if (DEV.has(f) || f.startsWith("render/") || f.startsWith("audio/") || f.startsWith("input/")) continue;
    if (!/\.tsx$/.test(f)) continue;
    it(f, () => assert.deepEqual(hardcoded(text), []));
  }
});
