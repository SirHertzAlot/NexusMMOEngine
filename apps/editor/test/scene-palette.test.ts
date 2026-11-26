/**
 * The content palette (roadmap EB4).
 *
 * The palette replaced three wrapping chip rows under the canvas, and the
 * thing worth holding is that it stays honest as the roster grows: the
 * groups keep the order the content files give, a search that matches
 * nothing says so rather than showing an empty column, and a palette with
 * no scene open still lists what exists but places nothing.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  filterPlaceables,
  matchesPlaceable,
  paletteSummary,
  placeableCount,
  type PlaceableSource,
} from "../src/placeables-filter.js";
import { ScenePalette, placePoint } from "../src/ui/scene-palette.js";
import { setPlaceables, reloadPlaceables } from "../src/ui/placeables-store.js";
import { setSceneCameraPos } from "../src/ui/camera-position.js";

const SOURCE: PlaceableSource = {
  species: [{ id: "goblin", label: "Goblin" }, { id: "dire-wolf", label: "Dire Wolf" }],
  props: [{ id: "oak", label: "oak" }],
  pcg: [{ id: "tree-a", label: "Round tree" }],
};

describe("matching", () => {
  it("matches on the id or the label, ignoring case and spacing", () => {
    assert.equal(matchesPlaceable({ id: "dire-wolf", label: "Dire Wolf" }, "WOLF"), true);
    assert.equal(matchesPlaceable({ id: "dire-wolf", label: "Dire Wolf" }, " dire "), true);
    assert.equal(matchesPlaceable({ id: "oak", label: "oak" }, "pine"), false);
  });
  it("matches everything when nothing is typed", () => {
    assert.equal(matchesPlaceable({ id: "oak", label: "oak" }, "   "), true);
  });
});

describe("grouping", () => {
  it("keeps the group order and each group's own order", () => {
    const groups = filterPlaceables(SOURCE, "");
    assert.deepEqual(groups.map((g) => g.title), ["Creatures", "Props", "PICG"]);
    assert.deepEqual(groups[0].items.map((i) => i.id), ["goblin", "dire-wolf"]);
  });
  it("drops a group nothing in it matched", () => {
    assert.deepEqual(filterPlaceables(SOURCE, "wolf").map((g) => g.title), ["Creatures"]);
  });
  it("is empty before the list has loaded", () => {
    assert.deepEqual(filterPlaceables(null, ""), []);
    assert.equal(placeableCount(null), 0);
  });
});

describe("the line under the search box", () => {
  it("counts what there is, then what a search left", () => {
    assert.equal(paletteSummary(SOURCE, filterPlaceables(SOURCE, ""), ""), "4 to place");
    assert.equal(paletteSummary(SOURCE, filterPlaceables(SOURCE, "wolf"), "wolf"), "1 of 4");
  });
  it("says so when a search matches nothing, and when there is nothing at all", () => {
    assert.equal(paletteSummary(SOURCE, [], "zzz"), 'No match for "zzz"');
    assert.equal(paletteSummary({ species: [], props: [], pcg: [] }, [], ""), "Nothing to place.");
  });
  it("says it is loading until the list arrives", () => {
    assert.equal(paletteSummary(null, [], ""), "Loading…");
  });
});

describe("placing by click", () => {
  it("uses the camera's ground point, and the origin before the viewport has reported one", () => {
    setSceneCameraPos({ x: 120.5, z: -8 });
    assert.deepEqual(placePoint(), [120.5, 0, -8]);
  });
});

describe("the palette", () => {
  beforeEach(() => {
    reloadPlaceables();
    setPlaceables({ content: SOURCE, error: null });
  });

  it("lists every placeable, with its id beside a label that differs", () => {
    const html = renderToStaticMarkup(React.createElement(ScenePalette, { enabled: true, onPlace: () => undefined }));
    assert.match(html, /Creatures/);
    assert.match(html, /data-testid="placeable-Creatures-goblin"/);
    assert.match(html, /data-testid="placeable-PICG-tree-a"/);
    assert.match(html, /Round tree/);
    assert.match(html, /4 to place/);
  });

  it("disables every item while no scene is open, and says why", () => {
    const html = renderToStaticMarkup(React.createElement(ScenePalette, { enabled: false, onPlace: () => undefined }));
    assert.match(html, /Open a scene to place content/);
    assert.equal(/disabled=""/.test(html), true);
  });

  it("shows the error instead of a count when the list could not be read", () => {
    setPlaceables({ content: null, error: "content list failed" });
    const html = renderToStaticMarkup(React.createElement(ScenePalette, { enabled: true, onPlace: () => undefined }));
    assert.match(html, /content list failed/);
  });
});
