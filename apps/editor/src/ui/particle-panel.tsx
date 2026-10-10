/**
 * Particle panel (EA22, VFX): visual particle effect authoring.
 *
 * Effects are engine-agnostic `VfxEffect` JSON documents
 * (`content/vfx/effects/<id>.json`), validated by the `VfxEffect` zod schema
 * from `@mmo-engine/art`. The viewport preview converts to three.quarks via
 * `vfxToQuarks()` — the agnostic format is the source of truth, never
 * quarks-native JSON.
 *
 * The bezier curve editor is ported from three.quarks-editor
 * (https://github.com/Alchemist0823/three.quarks-editor, MIT — see
 * ../vfx/LICENSE-quarks-editor).
 *
 * v1 scope: one emitter per effect, core properties (rate, bursts, shape,
 * lifetime/size/speed as curves, color, forces), live viewport preview,
 * tier budget warnings. Cut: node graph (API removed), script editor,
 * multi-emitter editing.
 */

import * as React from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { BatchedRenderer } from "three.quarks";
import {
  parseVfxEffect,
  vfxToQuarks,
  budgetForTier,
  DEFAULT_PARTICLE_BUDGETS,
  type VfxEffect,
  type VfxEmitter,
  type VfxSpawnShape,
  type QualityTier,
} from "@mmo-engine/art/browser";
import { getEffect, listEffects, saveEffect } from "../vfx/vfx-client.js";
import { BezierCurvesEditor } from "../vfx/bezier-editor.js";
import { PiecewiseBezier, Bezier } from "three.quarks";
import { Button, Field, Input, MIcon, NumberInput, Select } from "./components.js";
import { DocBar } from "./doc-bar.js";
import { useSaveTask } from "./use-save-task.js";

const SHAPES = ["point", "sphere", "box", "cone", "disc"] as const;

/** Build a default VfxEffect for a new effect. */
const makeDefaultEffect = (id: string): VfxEffect => ({
  id,
  name: id,
  version: 1,
  blendMode: "additive",
  authoredTier: "medium",
  emitters: [
    {
      name: "main",
      rate: 50,
      bursts: [],
      duration: 0,
      looping: true,
      maxParticles: 500,
      spawnShape: { kind: "sphere", radius: 0.5 },
      speed: 3,
      direction: { x: 0, y: 1, z: 0 },
      spread: 0.3,
      lifetime: { points: [{ t: 0, value: 1 }, { t: 1, value: 1 }] },
      size: { points: [{ t: 0, value: 0.2 }, { t: 1, value: 0.1 }] },
      color: {
        stops: [
          { t: 0, color: { r: 1, g: 0.6, b: 0.2, a: 1 } },
          { t: 1, color: { r: 1, g: 0.2, b: 0.1, a: 0 } },
        ],
      },
      forces: [{ kind: "gravity", acceleration: { x: 0, y: -2, z: 0 } }],
      position: { x: 0, y: 0, z: 0 },
    },
  ],
});

/** Convert a VfxCurve (agnostic) to PiecewiseBezier for the editor. */
const curveToBezier = (points: { t: number; value: number }[]): PiecewiseBezier => {
  const beziers = points.map((p, i) => {
    const next = points[Math.min(i + 1, points.length - 1)];
    return [new Bezier(p.value, p.value, next.value, next.value), p.t] as [Bezier, number];
  });
  return new PiecewiseBezier(beziers);
};

/** Convert PiecewiseBezier back to VfxCurve points. */
const bezierToCurve = (bezier: PiecewiseBezier): { t: number; value: number }[] => {
  // Sample the bezier at its control points
  const funcs = (bezier as unknown as { functions: { p: number[]; start: number }[] }).functions ?? [];
  return funcs.map((f) => ({ t: f.start, value: f.p[0] }));
};

export function ParticlePanel(): React.JSX.Element {
  const [effects, setEffects] = React.useState<string[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [effect, setEffect] = React.useState<VfxEffect | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [newId, setNewId] = React.useState("");
  const [playing, setPlaying] = React.useState(true);
  const [budgetWarn, setBudgetWarn] = React.useState<string | null>(null);
  const [activeTier, setActiveTier] = React.useState<QualityTier>("medium");
  const task = useSaveTask();

  const viewportRef = React.useRef<HTMLDivElement>(null);
  const batchedRef = React.useRef<BatchedRenderer | null>(null);
  const systemsRef = React.useRef<{ destroy(): void }[]>([]);

  const loadList = React.useCallback((): void => {
    listEffects().then(setEffects, (e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);

  React.useEffect(() => { loadList(); }, [loadList]);

  // Viewport setup
  React.useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);

    const camera = new THREE.PerspectiveCamera(60, el.clientWidth / el.clientHeight, 0.1, 100);
    camera.position.set(3, 2, 5);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1, 0);

    const batched = new BatchedRenderer();
    scene.add(batched);
    batchedRef.current = batched;

    const grid = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
    scene.add(grid);

    const clock = new THREE.Clock();
    let raf = 0;
    const animate = (): void => {
      raf = requestAnimationFrame(animate);
      const delta = Math.min(clock.getDelta(), 0.1);
      if (playing) batched.update(delta);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onResize = (): void => {
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      el.removeChild(renderer.domElement);
      batchedRef.current = null;
    };
  }, [playing]);

  // Rebuild preview when the effect changes
  React.useEffect(() => {
    const batched = batchedRef.current;
    if (!batched) return;
    // Clear old systems
    for (const s of systemsRef.current) batched.deleteSystem(s as never);
    systemsRef.current = [];
    if (!effect) return;
    try {
      const systems = vfxToQuarks(effect);
      for (const s of systems) {
        batched.addSystem(s);
        systemsRef.current.push(s as unknown as { destroy(): void });
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [effect]);

  // Budget check
  React.useEffect(() => {
    if (!effect) { setBudgetWarn(null); return; }
    const budget = budgetForTier(DEFAULT_PARTICLE_BUDGETS, activeTier);
    const total = effect.emitters.reduce((sum, e) => sum + e.maxParticles, 0);
    if (total > budget.maxParticles) {
      setBudgetWarn(`Exceeds ${activeTier} budget: ${total} > ${budget.maxParticles} max particles`);
    } else if (effect.emitters.length > budget.maxEmitters) {
      setBudgetWarn(`Exceeds ${activeTier} budget: ${effect.emitters.length} > ${budget.maxEmitters} max emitters`);
    } else {
      setBudgetWarn(null);
    }
  }, [effect, activeTier]);

  const loadEffect = React.useCallback((id: string): void => {
    setLoadError(null);
    setSelected(id);
    getEffect(id).then(
      (raw) => {
        try {
          setEffect(parseVfxEffect(raw));
          task.clear();
        } catch (e) {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      },
      (e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)),
    );
  }, [task]);

  const createNew = React.useCallback((): void => {
    const id = newId.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (!id) return;
    setEffect(makeDefaultEffect(id));
    setSelected(id);
    setNewId("");
    task.clear();
  }, [newId, task]);

  const save = React.useCallback((): void => {
    if (!selected || !effect) return;
    task.run(async () => {
      await saveEffect(selected, effect);
      loadList();
    }, { ok: `Saved ${selected}` });
  }, [selected, effect, task, loadList]);

  const updateEmitter = React.useCallback((fn: (e: VfxEmitter) => void): void => {
    setEffect((cur) => {
      if (!cur || cur.emitters.length === 0) return cur;
      const next = { ...cur, emitters: [{ ...cur.emitters[0] }] };
      fn(next.emitters[0]);
      return next;
    });
  }, []);

  const emitter = effect?.emitters[0] ?? null;

  return (
    <div className="flex h-full">
      {/* Effect list */}
      <div className="w-56 border-r border-zinc-800 p-3 flex flex-col gap-2">
        <div className="text-sm font-semibold text-zinc-200">Effects</div>
        <div className="flex gap-1">
          <Input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="new-effect-id" className="flex-1" />
          <Button onClick={createNew} disabled={!newId.trim()}><MIcon name="add" size={16} /></Button>
        </div>
        <div className="flex-1 overflow-y-auto flex flex-col gap-1">
          {effects.map((id) => (
            <button
              key={id}
              onClick={() => loadEffect(id)}
              className={`text-left px-2 py-1 rounded text-sm ${selected === id ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-800"}`}
            >
              {id}
            </button>
          ))}
          {effects.length === 0 && <div className="text-xs text-zinc-500">No effects yet.</div>}
        </div>
        <Field label="Preview tier">
          <Select value={activeTier} onChange={(e) => setActiveTier(e.target.value as QualityTier)}>
            {(["low", "medium", "high", "ultra"] as QualityTier[]).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
        </Field>
      </div>

      {/* Viewport */}
      <div className="flex-1 relative">
        <div ref={viewportRef} className="absolute inset-0" />
        <div className="absolute top-2 left-2 flex gap-1">
          <Button onClick={() => setPlaying((p) => !p)}><MIcon name={playing ? "pause" : "play_arrow"} size={16} /></Button>
        </div>
        {budgetWarn && (
          <div className="absolute top-2 right-2 bg-amber-900 text-amber-200 text-xs px-2 py-1 rounded">{budgetWarn}</div>
        )}
      </div>

      {/* Properties */}
      <div className="w-80 border-l border-zinc-800 p-3 overflow-y-auto flex flex-col gap-3">
        <div className="text-sm font-semibold text-zinc-200">Properties</div>
        {loadError && <div className="text-xs text-red-400">{loadError}</div>}
        {!emitter && <div className="text-xs text-zinc-500">Select or create an effect.</div>}
        {emitter && (
          <>
            <DocBar dirty={true} onSave={save} />
            <Field label="Emission rate (particles/sec)">
              <NumberInput value={emitter.rate} onChange={(v) => updateEmitter((e) => { e.rate = v; })} />
            </Field>
            <Field label="Max particles">
              <NumberInput value={emitter.maxParticles} onChange={(v) => updateEmitter((e) => { e.maxParticles = Math.max(1, Math.round(v)); })} />
            </Field>
            <Field label="Duration (sec, 0 = infinite)">
              <NumberInput value={emitter.duration} onChange={(v) => updateEmitter((e) => { e.duration = Math.max(0, v); })} />
            </Field>
            <Field label="Spawn shape">
              <Select
                value={emitter.spawnShape.kind}
                onChange={(e) => {
                  const kind = e.target.value as VfxSpawnShape["kind"];
                  updateEmitter((em) => {
                    em.spawnShape = kind === "point" ? { kind } :
                      kind === "sphere" ? { kind, radius: 0.5 } :
                      kind === "box" ? { kind, halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } :
                      kind === "cone" ? { kind, angle: 0.5, radius: 0.5, height: 1 } :
                      { kind, radius: 0.5, normal: { x: 0, y: 1, z: 0 } };
                  });
                }}
              >
                {SHAPES.map((k) => <option key={k} value={k}>{k}</option>)}
              </Select>
            </Field>
            <div className="text-xs font-semibold text-zinc-400 mt-2">Size over life</div>
            {typeof emitter.size !== "number" && (
              <BezierCurvesEditor
                value={curveToBezier(emitter.size.points)}
                onChange={(b) => updateEmitter((e) => { e.size = { points: bezierToCurve(b) }; })}
                width={240}
                height={120}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
