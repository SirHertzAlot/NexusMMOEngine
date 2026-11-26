/**
 * Forge inspector and theme selection (docs/EDITOR-UI-2026.md, slices EU1/EU3).
 *
 * The point of these tests is the claim the rebuild rests on: the new
 * presentation reads the SAME view-model as the Material 3 panel, and it
 * stays read-only. So the fixture is a real `EcsInspector` over a
 * synthetic snapshot — the projections under test are the shipped ones.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EcsInspector, type EntitySnapshot } from "../src/inspectors/ecs.js";
import {
  ForgeInspectorView,
  liveness,
  type ForgeInspectorSession,
} from "../src/ui/forge-inspector.js";
import { DEFAULT_THEME, resolveTheme, themeFromSearch } from "../src/theme.js";

function snapshot(over: { vx?: number; hp?: number } = {}): EntitySnapshot {
  return {
    tick: 4242,
    entities: new Map([
      [
        42n,
        {
          wireId: 42n,
          transform: { px: 3, py: 1.6, pz: 2.5, qx: 0, qy: 0, qz: 0, qw: 1, sx: 1, sy: 1, sz: 1 },
          velocity: { lx: over.vx ?? 0, ly: 0, lz: 0, ax: 0, ay: 0, az: 0 },
          health: { current: over.hp ?? 64, max: 100 },
        },
      ],
    ]),
  };
}

function session(over: { vx?: number; hp?: number } = {}): ForgeInspectorSession {
  const inspector = new EcsInspector(() => snapshot(over));
  return { selected: "42", detail: inspector.getEntity("42"), inspector };
}

describe("forge inspector", () => {
  it("lists the selected entity's real components", () => {
    const html = renderToStaticMarkup(
      React.createElement(ForgeInspectorView, { session: session() }),
    );
    assert.match(html, /Entity 42/);
    assert.match(html, /Components \(3\)/);
    assert.match(html, /Transform/);
    assert.match(html, /Health/);
    assert.match(html, /tick 4242/);
  });

  it("shows values the shipped view-model projected, not its own", () => {
    const html = renderToStaticMarkup(
      React.createElement(ForgeInspectorView, { session: session(), initialTab: "details" }),
    );
    // 1.6 comes out of projectTransform's three-decimal formatting.
    assert.match(html, /1\.600/);
    assert.match(html, /64\.000/);
  });

  it("names the entity's archetype from its components", () => {
    const html = renderToStaticMarkup(
      React.createElement(ForgeInspectorView, { session: session() }),
    );
    assert.match(html, /Transform · Velocity · Health/);
  });

  it("renders no control that could edit the entity", () => {
    const html = renderToStaticMarkup(
      React.createElement(ForgeInspectorView, { session: session() }),
    );
    assert.doesNotMatch(html, /<input/i);
    assert.doesNotMatch(html, /<select/i);
    assert.doesNotMatch(html, /<textarea/i);
    // Every button it does render is a tab, a disclosure or the disabled read-out.
    const enabled = html.match(/<button(?![^>]*disabled)[^>]*>/g) ?? [];
    for (const tag of enabled) {
      assert.ok(
        /role="tab"|aria-expanded=/.test(tag),
        `unexpected interactive control in a read-only panel: ${tag}`,
      );
    }
  });

  it("asks for a selection when there is none", () => {
    const html = renderToStaticMarkup(
      React.createElement(ForgeInspectorView, {
        session: { selected: null, detail: undefined, inspector: session().inspector },
      }),
    );
    assert.match(html, /Select an entity/);
  });

  it("reads liveness off the live values", () => {
    const fields = (s: ForgeInspectorSession) =>
      new Map((s.detail ?? []).map((c) => [c.component, new Map(c.fields.map((f) => [f.key, f.value]))]));
    assert.equal(liveness(fields(session())), "idle");
    assert.equal(liveness(fields(session({ vx: 1.4 }))), "moving");
    assert.equal(liveness(fields(session({ hp: 0 }))), "down");
    // Death wins over motion: a corpse sliding downhill is still down.
    assert.equal(liveness(fields(session({ vx: 1.4, hp: 0 }))), "down");
  });
});

describe("editor theme selection", () => {
  it("takes the theme from the URL when it names a real one", () => {
    assert.equal(themeFromSearch("?theme=forge"), "forge");
    assert.equal(themeFromSearch("?theme=m3"), "m3");
  });

  it("ignores a theme it does not know", () => {
    assert.equal(themeFromSearch("?theme=chartreuse"), null);
    assert.equal(themeFromSearch(""), null);
  });

  it("falls back to the Material 3 scheme", () => {
    assert.equal(resolveTheme(""), DEFAULT_THEME);
    assert.equal(DEFAULT_THEME, "m3");
  });
});
