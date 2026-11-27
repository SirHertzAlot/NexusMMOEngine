/**
 * The character creation form (roadmap EB7): the fields it offers, the
 * summary it shows, and the route that writes the document.
 *
 * The test that matters most is the last one: the host validates a save
 * with the art package's own reader, which is the same function the
 * server and the client use, so the form cannot accept a document the
 * game would then refuse.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { COLOUR_SLOTS, DETAIL_SLOTS, creationRulesDocument } from "@mmo-engine/art/browser";
import { CREATION_COLOUR_FIELDS, CREATION_FIELDS, CREATION_PART_FIELDS, creationSummary } from "../src/creation-rules.js";
import { CreationSummary, SwatchStrip } from "../src/ui/creation-rules-panel.js";
import { CONTENT_DOC_FILES } from "../src/content-docs.js";
import { CONTENT_DOC_CHECKS, handleContentDocsRoute, readContentDoc } from "../src/content-docs-host.js";

/** This repository (the tests run from apps/editor/dist/test). */
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * A throwaway game project: its own content folder, and this
 * repository's packages, because the host validates a save with the art
 * package's built reader.
 */
const repoRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-creation-editor-"));
  mkdirSync(join(dir, "content"), { recursive: true });
  symlinkSync(join(REPO, "packages"), join(dir, "packages"), "dir");
  return dir;
};

describe("the character creation fields", () => {
  it("offer every slot the engine knows, and no slot it does not", () => {
    const slot = CREATION_PART_FIELDS.find((f) => f.key === "slot");
    assert.ok(slot && slot.kind === "enum" && Array.isArray(slot.options));
    assert.deepEqual(slot.options, [...DETAIL_SLOTS], "the form's slots are the art package's, not a copy");
    const colour = CREATION_COLOUR_FIELDS.find((f) => f.key === "slot");
    assert.ok(colour && colour.kind === "enum" && Array.isArray(colour.options));
    assert.deepEqual(colour.options, [...COLOUR_SLOTS]);
  });

  it("say which fields the server only reads at start", () => {
    assert.ok(CREATION_FIELDS.every((f) => f.restart === true));
  });

  it("do not offer the character slot count, which social.json owns", () => {
    assert.ok(!CREATION_FIELDS.some((f) => f.key === "maxCharacters"));
  });
});

describe("the summary of a document", () => {
  it("says what each gender is offered", () => {
    const { lines, problems } = creationSummary(creationRulesDocument());
    assert.deepEqual(problems, []);
    assert.equal(lines.length, 3, "one line per gender, then the body");
    assert.match(lines[0], /^A male character chooses head, hair, eyebrows, facialHair, ears/);
    assert.match(lines[1], /^A female character chooses head, hair, eyebrows, ears/);
    assert.match(lines[1], /colours skin, hair, scar, bodyArt/);
    assert.match(lines[2], /starter armour/);
  });

  it("follows an edit rather than describing the defaults", () => {
    const doc = creationRulesDocument() as { parts: unknown[]; lockBodyToStarter: boolean };
    const { lines } = creationSummary({ ...doc, parts: doc.parts.slice(0, 1), lockBodyToStarter: false });
    assert.match(lines[0], /chooses head,? ?/);
    assert.ok(!lines[0].includes("ears"));
    assert.match(lines[2], /Any body set/);
  });

  it("reports what the server would refuse instead of describing it", () => {
    const { lines, problems } = creationSummary({ parts: [] });
    assert.deepEqual(lines, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /head/);
  });
});

describe("the panel's pieces", () => {
  it("draws a swatch per colour and skips what is not one", () => {
    const html = renderToStaticMarkup(React.createElement(SwatchStrip, { colours: ["#ff0000", "nope", "#00ff00"] }));
    assert.equal(html.match(/rounded-sm/g)?.length, 2);
    assert.match(html, /background:#ff0000/);
  });

  it("draws nothing for a row with no usable swatches", () => {
    assert.equal(renderToStaticMarkup(React.createElement(SwatchStrip, { colours: ["", "x"] })), "");
  });

  it("shows the refusal rather than a summary when the document is wrong", () => {
    const html = renderToStaticMarkup(React.createElement(CreationSummary, { content: { genders: [] } }));
    assert.match(html, /would refuse/);
  });
});

describe("saving the document", () => {
  it("writes the file the server and the client read", async () => {
    const root = repoRoot();
    const content = creationRulesDocument();
    const reply = await handleContentDocsRoute(root, "PUT", "/api/editor/docs/characterCreation", JSON.stringify({ content }));
    assert.equal(reply?.status, 200, JSON.stringify(reply?.body));
    const written = JSON.parse(readFileSync(join(root, "content", CONTENT_DOC_FILES.characterCreation), "utf8")) as unknown;
    assert.deepEqual(written, content);
    assert.deepEqual(readContentDoc(root, "characterCreation"), content);
  });

  it("refuses a document the game would refuse, and writes nothing", async () => {
    const root = repoRoot();
    const reply = await handleContentDocsRoute(root, "PUT", "/api/editor/docs/characterCreation", JSON.stringify({ content: { parts: [{ slot: "torso" }] } }));
    assert.equal(reply?.status, 400);
    const body = reply?.body as { issues: Array<{ path: string; message: string }> };
    assert.ok(body.issues.some((i) => i.path === "parts.0.slot"), JSON.stringify(body));
    assert.equal(readContentDoc(root, "characterCreation"), undefined, "nothing was written");
  });

  it("checks it with the art package's own reader", async () => {
    const root = REPO;
    const issues = await CONTENT_DOC_CHECKS.characterCreation(root, { colours: [{ slot: "skin", swatches: ["teal"] }] });
    assert.deepEqual(issues, [{ file: "characterCreation.json", path: "colours.0.swatches.0", message: "must be #rrggbb" }]);
  });

  it("serves a game its own file, and 404 when it has none", async () => {
    const root = repoRoot();
    const missing = await handleContentDocsRoute(root, "GET", "/api/editor/docs/characterCreation", undefined);
    assert.equal(missing?.status, 404, "no file: the panel offers to write the defaults");
  });

  it("accepts a game that only changes one thing", async () => {
    const root = repoRoot();
    writeFileSync(join(root, "content", CONTENT_DOC_FILES.characterCreation), JSON.stringify({ lockBodyToStarter: false }), "utf8");
    assert.deepEqual(readContentDoc(root, "characterCreation"), { lockBodyToStarter: false });
    const reply = await handleContentDocsRoute(root, "GET", "/api/editor/docs/characterCreation", undefined);
    assert.equal(reply?.status, 200);
  });
});
