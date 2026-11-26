/**
 * The flow's screen preview (roadmap EB6).
 *
 * The part worth guarding is not the iframe: it is that the URL "Play from"
 * builds carries the dev account's user and password in its query string,
 * and the pane prints a URL on screen. Everything shown has to be masked,
 * and the mask has to survive the parameters appearing in any order.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FlowDoc } from "@mmo-engine/scene";
import {
  PREVIEW_SIZES,
  emptyPreviewNote,
  frameStyle,
  maskUrl,
  previewSize,
  previewTarget,
} from "../src/flow-preview.js";
import { FlowPreviewPane } from "../src/ui/flow-preview-pane.js";

const DOC: FlowDoc = {
  version: 1,
  start: "login",
  nodes: {
    login: { scene: "login" },
    create: { scene: "character-creation" },
    world: { scene: "world" },
  },
  edges: [
    { from: "login", to: "create", event: "new-character" },
    { from: "create", to: "world", event: "created" },
  ],
} as unknown as FlowDoc;

const CLIENT = "http://localhost:5173";
const SERVER = { url: "ws://localhost:7777", user: "dev", pass: "hunter2" };

describe("masking", () => {
  it("takes the password and the account out, wherever they sit", () => {
    const url = "http://localhost:5173/?start=world&server=ws%3A%2F%2Fx&user=dev&pass=hunter2";
    const shown = maskUrl(url);
    assert.equal(shown.includes("hunter2"), false);
    assert.equal(shown.includes("dev"), false);
    assert.match(shown, /start=world/);
  });
  it("stops at the next parameter rather than eating the rest", () => {
    assert.equal(maskUrl("http://x/?pass=a&start=world"), "http://x/?pass=…&start=world");
  });
  it("leaves a URL with nothing secret in it alone", () => {
    assert.equal(maskUrl(`${CLIENT}/?preview=character`), `${CLIENT}/?preview=character`);
  });
});

describe("the target", () => {
  it("is the plain client for the start node", () => {
    const t = previewTarget(DOC, "login", { client: CLIENT });
    assert.deepEqual(t, { node: "login", url: `${CLIENT}/`, shown: `${CLIENT}/` });
  });
  it("carries the account for a node that needs a server, and shows it masked", () => {
    const t = previewTarget(DOC, "world", { client: CLIENT, server: SERVER });
    assert.ok("url" in t);
    assert.match(t.url, /pass=hunter2/);
    assert.equal(t.shown.includes("hunter2"), false);
  });
  it("passes the reason through when there is no URL to show", () => {
    assert.deepEqual(previewTarget(DOC, "world", { client: CLIENT }), {
      error: 'Play from "world" needs a running server: enter its URL and a dev account',
    });
    assert.deepEqual(previewTarget(DOC, "nope", { client: CLIENT }), { error: 'no node "nope"' });
  });
});

describe("sizes", () => {
  it("fills the pane by default, and takes a fixed frame otherwise", () => {
    assert.deepEqual(frameStyle(previewSize("fit")), { width: "100%", height: "100%" });
    assert.deepEqual(frameStyle(previewSize("phone")), { width: "390px", height: "844px" });
  });
  it("falls back to fit for a size it does not know", () => {
    assert.equal(previewSize("something-else").id, "fit");
  });
});

describe("the empty pane", () => {
  it("asks for the client URL first, then for a node", () => {
    assert.match(emptyPreviewNote("", null), /client's dev server URL/);
    assert.match(emptyPreviewNote(CLIENT, null), /Pick a node/);
    assert.equal(emptyPreviewNote(CLIENT, "world"), "");
  });
});

describe("the pane", () => {
  it("shows the note and no frame when there is nothing to show", () => {
    const html = renderToStaticMarkup(
      React.createElement(FlowPreviewPane, { target: null, note: "Pick a node.", sizeId: "fit", onSize: () => undefined, onOpenTab: () => undefined }),
    );
    assert.match(html, /Pick a node\./);
    assert.equal(html.includes("<iframe"), false);
  });

  it("frames the client, and never prints the password it is loading", () => {
    const target = previewTarget(DOC, "world", { client: CLIENT, server: SERVER });
    assert.ok("url" in target);
    const html = renderToStaticMarkup(
      React.createElement(FlowPreviewPane, { target, note: "", sizeId: "phone", onSize: () => undefined, onOpenTab: () => undefined }),
    );
    assert.match(html, /<iframe/);
    assert.match(html, /sandbox="allow-scripts/);
    assert.match(html, /width:390px/);
    // The src must carry it — that is the session being previewed — but
    // nothing the person reads on screen may.
    const visible = html.replace(/src="[^"]*"/, "src=…");
    assert.equal(visible.includes("hunter2"), false);
  });

  it("offers every size, with the current one pressed", () => {
    const target = previewTarget(DOC, "login", { client: CLIENT });
    assert.ok("url" in target);
    const html = renderToStaticMarkup(
      React.createElement(FlowPreviewPane, { target, note: "", sizeId: "desktop", onSize: () => undefined, onOpenTab: () => undefined }),
    );
    for (const s of PREVIEW_SIZES) assert.match(html, new RegExp(`data-testid="preview-size-${s.id}"`));
    assert.match(html, /aria-pressed="true"[^>]*data-testid="preview-size-desktop"|data-testid="preview-size-desktop"[^>]*aria-pressed="true"/);
  });
});
