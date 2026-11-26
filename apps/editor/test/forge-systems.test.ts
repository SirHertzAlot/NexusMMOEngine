/**
 * Forge systems list (docs/EDITOR-UI-2026.md §2.3, slice EU4).
 *
 * The panel's only contribution is a join: the committed ECS graph's
 * component signatures on one side, the running server's per-system
 * tick cost on the other. So these tests pin the inversion (the graph
 * is component-keyed, the list is system-keyed) and pin that neither
 * side invents the other — no server means no cost column, not zeros.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ForgeSystemsView,
  joinCosts,
  orderRows,
  systemSignatures,
  type SystemSignature,
} from "../src/ui/forge-systems.js";
import { indexEcsGraph, type EcsGraphPayload } from "../src/ecs-graph-model.js";

/**
 * A small graph in the shape `/api/editor/graph` serves: two components,
 * three systems, one of which only had its access inferred.
 */
const edge = (
  from: string,
  to: string,
  kind: "reads" | "writes" | "excludes",
  confidence: "declared" | "inferred",
) => ({ from, to, kind, confidence, source: "test" }) as const;

const PAYLOAD: EcsGraphPayload = {
  meta: { schemaVersion: 1, builtFromCommit: "abc1234", graphHash: "deadbeef" },
  nodes: [
    { id: "component:Transform", kind: "component", name: "Transform", fields: [{ name: "px", type: "f32" }] },
    { id: "component:Velocity", kind: "component", name: "Velocity", fields: [{ name: "lx", type: "f32" }] },
    { id: "component:Dead", kind: "component", name: "Dead", fields: [], tag: true },
    { id: "system:movement", kind: "system", name: "movement", role: "simulation", declared: true },
    { id: "system:interest", kind: "system", name: "interest", role: "simulation", declared: false },
    { id: "system:cleanup", kind: "system", name: "cleanup", role: "simulation", declared: true },
  ],
  edges: [
    edge("system:movement", "component:Transform", "writes", "declared"),
    edge("system:movement", "component:Velocity", "reads", "declared"),
    // movement also reads what it writes: the stronger access must win.
    edge("system:movement", "component:Transform", "reads", "declared"),
    edge("system:interest", "component:Transform", "reads", "inferred"),
    edge("system:cleanup", "component:Dead", "excludes", "declared"),
  ],
};

function signatures(): SystemSignature[] {
  return systemSignatures(indexEcsGraph(PAYLOAD));
}

function find(name: string): SystemSignature {
  const row = signatures().find((s) => s.system === name);
  assert.ok(row, `no row for ${name}`);
  return row;
}

describe("inverting the graph into one row per system", () => {
  it("names every system the graph knows, in order", () => {
    assert.deepEqual(
      signatures().map((s) => s.system),
      ["cleanup", "interest", "movement"],
    );
  });

  it("lets a written component outrank the same component read", () => {
    const movement = find("movement");
    assert.deepEqual(movement.writes, ["Transform"]);
    assert.deepEqual(movement.reads, ["Velocity"]);
    assert.ok(!movement.reads.includes("Transform"));
  });

  it("keeps excludes separate from access", () => {
    const cleanup = find("cleanup");
    assert.deepEqual(cleanup.excludes, ["Dead"]);
    assert.deepEqual(cleanup.writes, []);
    assert.deepEqual(cleanup.reads, []);
  });

  it("reports a row at its WEAKEST confidence, since that is what it can be trusted to", () => {
    assert.equal(find("movement").confidence, "declared");
    assert.equal(find("interest").confidence, "inferred");
  });
});

describe("joining costs", () => {
  it("leaves the cost empty when no server is running", () => {
    for (const row of joinCosts(signatures(), null)) assert.equal(row.costMs, null);
  });

  it("matches a cost to its system and leaves the rest empty", () => {
    const rows = joinCosts(signatures(), new Map([["movement", 2.5]]));
    assert.equal(rows.find((r) => r.system === "movement")?.costMs, 2.5);
    assert.equal(rows.find((r) => r.system === "interest")?.costMs, null);
  });

  it("invents no system for a cost the graph does not name", () => {
    const rows = joinCosts(signatures(), new Map([["ghost-system", 9]]));
    assert.ok(!rows.some((r) => r.system === "ghost-system"));
    assert.equal(rows.length, 3);
  });

  it("orders by cost when costs are known, by name when they are not", () => {
    const named = orderRows(joinCosts(signatures(), null));
    assert.deepEqual(named.map((r) => r.system), ["cleanup", "interest", "movement"]);
    const costed = orderRows(
      joinCosts(signatures(), new Map([["interest", 4], ["movement", 1]])),
    );
    assert.deepEqual(costed.map((r) => r.system), ["interest", "movement", "cleanup"]);
  });
});

describe("the panel", () => {
  it("draws each system's signature", () => {
    const html = renderToStaticMarkup(
      React.createElement(ForgeSystemsView, { signatures: signatures(), costs: null }),
    );
    assert.match(html, /movement/);
    assert.match(html, /Transform/);
    assert.match(html, /Velocity/);
    assert.match(html, /Systems \(3\)/);
  });

  it("says how many systems declare their access rather than implying all do", () => {
    const html = renderToStaticMarkup(
      React.createElement(ForgeSystemsView, { signatures: signatures(), costs: null }),
    );
    assert.match(html, /2\/3 declare their access/);
    assert.match(html, /inferred/);
  });

  it("says there is no cost rather than printing zeros, with no server", () => {
    const html = renderToStaticMarkup(
      React.createElement(ForgeSystemsView, { signatures: signatures(), costs: null }),
    );
    assert.match(html, /no server running, so no cost/);
    assert.doesNotMatch(html, /0\.000 ms/);
  });

  it("asks for the graph rather than drawing an empty list", () => {
    const html = renderToStaticMarkup(
      React.createElement(ForgeSystemsView, { signatures: null, costs: null }),
    );
    assert.match(html, /No ECS graph available/);
  });

  it("edits nothing", () => {
    const html = renderToStaticMarkup(
      React.createElement(ForgeSystemsView, { signatures: signatures(), costs: null }),
    );
    assert.doesNotMatch(html, /<input/i);
    assert.doesNotMatch(html, /<button/i);
  });
});
