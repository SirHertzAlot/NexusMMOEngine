/**
 * Before/after preview for the 2026 editor design language.
 *
 * Mounts the REAL Material 3 ECS panel and the REAL Forge inspector over
 * one fixture snapshot, so the two shots differ only in presentation.
 * Nothing here reimplements a panel; the fixture is the only thing this
 * file adds, and it is fed through the shipped `EcsInspector`
 * view-model, so every value on screen was projected by production code.
 *
 * Bundled and photographed by capture.mjs beside it, which injects the
 * editor's real Tailwind output and forge.css rather than importing them
 * here (esbuild does not run the editor's PostCSS pipeline).
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import type { EntitySnapshot } from "../../inspectors/ecs.js";
import { EcsInspectorPanel } from "../ecs-inspector.js";
import { ForgeEntityInspector } from "../forge-inspector.js";

/** One small world: a moving drone, a still prop, a downed guard. */
const SNAPSHOT: EntitySnapshot = {
  tick: 184_210,
  entities: new Map([
    [
      13n,
      {
        wireId: 13n,
        transform: { px: 3, py: 1.6, pz: 2.5, qx: 0, qy: 0, qz: 0, qw: 1, sx: 1, sy: 1, sz: 1 },
        velocity: { lx: 1.4, ly: 0, lz: -0.35, ax: 0, ay: 0.6, az: 0 },
        health: { current: 64, max: 100 },
        chunk: { chunkId: 182n, seed: 90_210n, lod: 0 },
        body: {
          shapeKind: 1, halfX: 0.4, halfY: 0.9, halfZ: 0.4, radius: 0.4,
          mass: 72, motionType: 2, layer: 1, friction: 0.6, restitution: 0.1,
        },
      },
    ],
    [
      21n,
      {
        wireId: 21n,
        transform: { px: -8, py: 0, pz: 12, qx: 0, qy: 0, qz: 0, qw: 1, sx: 2, sy: 2, sz: 2 },
        chunk: { chunkId: 182n, seed: 90_210n, lod: 1 },
      },
    ],
    [
      34n,
      {
        wireId: 34n,
        transform: { px: 1.2, py: 0, pz: -4.5, qx: 0, qy: 0, qz: 0, qw: 1, sx: 1, sy: 1, sz: 1 },
        velocity: { lx: 0, ly: 0, lz: 0, ax: 0, ay: 0, az: 0 },
        health: { current: 0, max: 100 },
      },
    ],
  ]),
};

const fixture = (): EntitySnapshot => SNAPSHOT;

function Frame({
  title,
  theme,
  children,
}: {
  title: string;
  theme: "m3" | "forge";
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      data-shot={theme === "m3" ? "before" : "after"}
      data-theme={theme}
      style={{ width: 560 }}
    >
      <h2
        style={{
          font: "600 11px/1.4 system-ui, sans-serif",
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "#8fa3b8",
          margin: "0 0 8px",
        }}
      >
        {title}
      </h2>
      <div
        style={{
          height: 760,
          overflow: "hidden",
          background: theme === "forge" ? "var(--fg-canvas)" : "var(--m3-surface)",
        }}
      >
        {children}
      </div>
    </section>
  );
}

function Preview(): React.JSX.Element {
  // Both halves live in one document: forge.css is written as attribute
  // selectors, so each half carries its own theme and the comparison is
  // one photograph rather than two.
  return (
    <div style={{ display: "flex", gap: 24, padding: 24, alignItems: "flex-start" }}>
      <Frame title="Today · Material 3" theme="m3">
        <EcsInspectorPanel fixture={fixture} initialSelected="13" />
      </Frame>
      <Frame title="Rebuilt · Forge" theme="forge">
        <ForgeEntityInspector fixture={fixture} initialSelected="13" />
      </Frame>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("forge preview: #root missing");
createRoot(root).render(<Preview />);
