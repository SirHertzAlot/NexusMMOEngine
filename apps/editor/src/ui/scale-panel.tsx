/**
 * Scale view (Art & audio): content/scale.json as a form. The global factor,
 * one per kind of object, and per-asset corrections (an exact id or a prefix
 * ending in `*`), checked as you type with the shared validateScale, and a
 * gauge that sizes the local art catalog's models under the current factors
 * beside a 1.8 m character, flagging categories whose typical size is off.
 * Save, Undo, Redo and Revert go through the document-actions registry; the
 * host validates again and writes nothing when it refuses.
 */
import * as React from "react";
import { resolveScale, SCALE_CATEGORIES, validateScale, type SceneIssue, type ScaleDoc } from "@mmo-engine/scene";
import { issueCount } from "../save-outcome.js";
import { getGaugeModels, getScale, saveScale } from "../scale-client.js";
import { parseFactor, removeAsset, renameAsset, scaleGauge, setAsset, setCategory, setGlobal, type GaugeModel } from "../scale-model.js";
import { Button } from "./components.js";
import { DocBar } from "./doc-bar.js";
import { useDocActions } from "./doc-actions.js";
import { createGaugeScene, type GaugeScene } from "./scale-gauge-scene.js";
import { useDocument } from "./use-document.js";
import { useSaveTask } from "./use-save-task.js";
import { Pill, SectionLabel } from "./widgets.js";

const dim = { color: "var(--m3-on-surface-variant)" } as const;
const box = { background: "var(--m3-surface-2)" } as const;

/** A number edited as text and committed when you leave it (Enter), so a half-typed "0." never reaches the document. */
function FactorInput({ value, label, onCommit, onClear, invalid }: { value: number | undefined; label: string; onCommit: (n: number) => void; onClear?: () => void; invalid?: boolean }): React.JSX.Element {
  const [text, setText] = React.useState(value === undefined ? "" : String(value));
  React.useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  const n = parseFactor(text);
  const commit = (): void => {
    if (text.trim() === "" && onClear) return onClear();
    if (n !== null && n !== value) onCommit(n);
  };
  return (
    <input
      value={text}
      inputMode="decimal"
      aria-label={label}
      aria-invalid={invalid || (text.trim() !== "" && n === null) || undefined}
      placeholder={onClear ? "1 (unset)" : undefined}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setText(value === undefined ? "" : String(value));
      }}
      className="m3-focus w-24 rounded border bg-transparent px-1.5 font-mono text-[12.5px]"
      style={{ height: 28, borderColor: invalid || (text.trim() !== "" && n === null) ? "#FFB4AB" : "var(--m3-outline-variant)" }}
    />
  );
}

/** The gauge's three.js canvas; the scene is made once and fed each new gauge. */
function GaugeCanvas({ gauge }: { gauge: ReturnType<typeof scaleGauge> }): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const sceneRef = React.useRef<GaugeScene | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      sceneRef.current = createGaugeScene(canvas);
    } catch {
      setFailed(true);
      return;
    }
    const ro = new ResizeObserver(() => sceneRef.current?.resize());
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);
  React.useEffect(() => sceneRef.current?.update(gauge), [gauge, failed]);
  return failed ? <p className="p-3 text-xs" style={dim}>3D preview unavailable (no WebGL).</p> : <canvas ref={canvasRef} data-testid="scale-canvas" aria-label="Scale gauge: a 1.8 m character beside each category's typical height" className="h-full w-full" />;
}

const tone = { ok: "ok", low: "warn", high: "err", none: "plain" } as const;
const word = { ok: "in band", low: "too small", high: "too big", none: "no models" } as const;
const m = (n: number): string => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));

export function ScalePanel(): React.JSX.Element {
  const doc = useDocument<ScaleDoc>();
  const task = useSaveTask<SceneIssue>();
  const [models, setModels] = React.useState<GaugeModel[] | null>(null);
  const [newKey, setNewKey] = React.useState("");

  const load = React.useCallback((): void => {
    task.setStatus({ tone: "info", text: "loading…" });
    getScale()
      .then((d) => {
        doc.load(d);
        task.clear();
      })
      .catch((e: unknown) => task.setStatus({ tone: "bad", text: e instanceof Error ? e.message : String(e) }));
  }, []);
  React.useEffect(() => load(), [load]);
  React.useEffect(() => {
    void getGaugeModels().then(setModels);
  }, []);

  const value = doc.value;
  const live = React.useMemo(() => (value ? validateScale(value) : []), [value]);
  const gauge = React.useMemo(() => (value && models ? scaleGauge(models, value) : null), [value, models]);
  const save = async (): Promise<void> => {
    if (!value) return;
    if (await task.run(() => saveScale(value), { ok: "Saved content/scale.json", refused: (i) => `Not saved: ${issueCount(i.length)}` })) doc.markSaved(value);
  };
  useDocActions(() => {
    if (!value) return null;
    return {
      label: "scale",
      canSave: doc.dirty && live.length === 0,
      ...doc.history,
      problems: live.map((i) => ({ severity: "error" as const, where: i.path, message: i.message })),
      save: () => void save(),
      revert: doc.revert,
      canRevert: doc.dirty,
      exportDoc: () => ({ name: "scale", data: value }),
      importDoc: (incoming: unknown) => {
        const found = validateScale(incoming);
        if (found.length > 0) throw new Error(`invalid scale: ${found.slice(0, 3).map((i) => `${i.path} ${i.message}`).join("; ")}`);
        doc.edit(incoming as ScaleDoc);
      },
    };
  });

  if (!value) {
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-[13px]" data-testid="scale-panel">
        <p>Scale: {task.status?.text ?? "loading…"}</p>
        {task.status?.tone === "bad" && <Button size="sm" variant="outline" onClick={load}>Retry</Button>}
      </div>
    );
  }

  const at = (path: string): string | undefined => (task.issues.length > 0 ? task.issues : live).find((i) => i.path === path)?.message;
  const issues = task.issues.length > 0 ? task.issues : live;
  const rows = Object.entries(value.assets);
  const keyTaken = newKey.trim() === "" || newKey.trim() in value.assets;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-auto p-2" data-testid="scale-panel">
      <div className="flex flex-wrap items-center gap-2">
        <DocBar dirty={doc.dirty} busy={task.busy} saveBlocked={live.length > 0} history={doc.history} onSave={() => void save()} onRevert={doc.revert}>
          <Button size="sm" variant="outline" disabled={task.busy} onClick={load}>Reload</Button>
        </DocBar>
        <span className="text-xs" style={{ color: task.status?.tone === "bad" ? "#FFB4AB" : "var(--m3-on-surface-variant)" }} role="status">{task.status?.text ?? ""}</span>
        <span className="ml-auto"><Pill tone={issues.length > 0 ? "err" : "ok"}>{issues.length > 0 ? issueCount(issues.length) : "valid"}</Pill></span>
      </div>

      <div className="grid gap-2 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <section className="rounded-xl p-3" style={box} aria-label="Factors">
            <SectionLabel>Factors (global × category × asset)</SectionLabel>
            <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 text-[13px]">
              <span>Whole world</span>
              <FactorInput label="Global factor" value={value.global} invalid={at("global") !== undefined} onCommit={(n) => doc.edit(setGlobal(value, n))} />
              {at("global") && <span className="col-span-2 text-[11px]" style={{ color: "#FFB4AB" }}>{at("global")}</span>}
              {SCALE_CATEGORIES.map((c) => (
                <React.Fragment key={c}>
                  <span>{c}</span>
                  <FactorInput
                    label={`${c} factor`}
                    value={value.categories[c]}
                    invalid={at(`categories.${c}`) !== undefined}
                    onCommit={(n) => doc.edit(setCategory(value, c, n))}
                    onClear={() => doc.edit(setCategory(value, c, undefined))}
                  />
                  {at(`categories.${c}`) && <span className="col-span-2 text-[11px]" style={{ color: "#FFB4AB" }}>{at(`categories.${c}`)}</span>}
                </React.Fragment>
              ))}
            </div>
          </section>

          <section className="rounded-xl p-3" style={box} aria-label="Per-asset corrections">
            <SectionLabel>Per-asset corrections</SectionLabel>
            <p className="mb-2 text-[11px]" style={dim}>An exact asset id, or a prefix ending in * (the longest prefix wins; an exact id beats a prefix).</p>
            {rows.length === 0 && <p className="text-xs" style={dim}>None.</p>}
            {rows.map(([key, factor]) => (
              <div key={key} className="mb-1.5 flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <KeyInput value={key} onCommit={(to) => doc.edit(renameAsset(value, key, to))} />
                  <FactorInput label={`${key} factor`} value={factor} invalid={at(`assets.${key}`) !== undefined} onCommit={(n) => doc.edit(setAsset(value, key, n))} />
                  <Button size="sm" variant="outline" aria-label={`Remove ${key}`} onClick={() => doc.edit(removeAsset(value, key))}>Remove</Button>
                </div>
                {at(`assets.${key}`) && <span className="text-[11px]" style={{ color: "#FFB4AB" }}>{at(`assets.${key}`)}</span>}
              </div>
            ))}
            <div className="mt-2 flex items-center gap-2">
              <input
                value={newKey}
                aria-label="New correction id"
                placeholder="pack/Model or pack/Prefix*"
                onChange={(e) => setNewKey(e.target.value)}
                className="m3-focus w-56 rounded border bg-transparent px-1.5 font-mono text-[12.5px]"
                style={{ height: 28, borderColor: "var(--m3-outline-variant)" }}
              />
              <Button size="sm" variant="outline" disabled={keyTaken} onClick={() => { doc.edit(setAsset(value, newKey.trim(), 1)); setNewKey(""); }}>Add correction</Button>
            </div>
          </section>

          <section className="rounded-xl p-3" style={box} role="list" aria-label="Problems">
            <SectionLabel>{issues.length === 0 ? "No problems" : issueCount(issues.length)}</SectionLabel>
            {issues.map((i, k) => <p key={k} role="listitem" className="text-xs" style={{ color: "#FFB4AB" }}>{i.path || "(document)"}: {i.message}</p>)}
          </section>
        </div>

        <section className="flex min-h-0 flex-col gap-2 rounded-xl p-3" style={box} aria-label="Scale gauge">
          <SectionLabel>Gauge: typical height next to a 1.8 m character</SectionLabel>
          <div className="h-56 overflow-hidden rounded-lg" style={{ background: "#0b1020" }}>
            {gauge ? <GaugeCanvas gauge={gauge} /> : <p className="p-3 text-xs" style={dim}>{models === null ? "Reading the art catalog…" : ""}</p>}
          </div>
          {models !== null && models.length === 0 && <p className="text-xs" style={dim}>No art catalog here (the local assets folder is missing), so there are no models to size.</p>}
          {gauge && models !== null && models.length > 0 && (
            <table className="w-full text-left text-xs" aria-label="Scale gauge table">
              <thead style={dim}>
                <tr><th>Category</th><th>Models</th><th>Factor</th><th>Typical</th><th>Range</th><th>Band</th><th /></tr>
              </thead>
              <tbody>
                {gauge.rows.map((r) => (
                  <tr key={r.category} data-testid={`gauge-${r.category}`}>
                    <td>{r.category}</td>
                    <td>{r.count}</td>
                    <td className="font-mono">{m(r.factor)}</td>
                    <td className="font-mono">{r.count > 0 ? `${m(r.typical)} m` : "–"}</td>
                    <td className="font-mono">{r.count > 0 ? `${m(r.min)}–${m(r.max)} m` : "–"}</td>
                    <td className="font-mono">{r.band ? `${r.band[0]}–${r.band[1]} m` : "–"}</td>
                    <td><Pill tone={tone[r.status]}>{word[r.status]}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-[11px]" style={dim}>
            Resolved for a building: ×{m(resolveScale(value, "building"))}, tree ×{m(resolveScale(value, "tree"))}, rock ×{m(resolveScale(value, "rock"))}, plant ×{m(resolveScale(value, "plant"))}, prop ×{m(resolveScale(value, "prop"))} (before per-asset corrections).
          </p>
        </section>
      </div>
    </div>
  );
}

/** An asset id edited in place and committed when you leave it. */
function KeyInput({ value, onCommit }: { value: string; onCommit: (to: string) => void }): React.JSX.Element {
  const [text, setText] = React.useState(value);
  React.useEffect(() => setText(value), [value]);
  return (
    <input
      value={text}
      aria-label={`Asset id ${value}`}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => (text === value ? undefined : text.trim() === "" ? setText(value) : (onCommit(text), setText(value)))}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="m3-focus w-40 rounded border bg-transparent px-1.5 font-mono text-[12.5px]"
      style={{ height: 28, borderColor: "var(--m3-outline-variant)" }}
    />
  );
}
