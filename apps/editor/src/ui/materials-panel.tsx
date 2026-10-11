/**
 * Materials panel (roadmap EA22): content/materials/materials.json, the
 * toon look and the terrain surfaces' tint, tile size and footstep sound.
 * The client applies it at start (toon shading, surface manifest, footsteps
 * by surface); reload the client to see a change. The per-material files
 * beside it (content/materials/<name>.json) are single material definitions
 * and are not edited here.
 */
import * as React from "react";
import { TOON_ROW_NAMES, type MaterialsDoc, type Rgb } from "@mmo-engine/art/browser";
import { getAudioEventNames } from "../media-client.js";
import { hexToLinear, linearToHex, toonColour } from "../toon-preview.js";
import { Heading, MediaDocBar, Num, Txt } from "./animation-views.js";
import { Button, CheckField } from "./components.js";
import { useMediaDoc } from "./use-media-doc.js";

type Row = (typeof TOON_ROW_NAMES)[number];

export function MaterialsPanel(): React.JSX.Element {
  const materials = useMediaDoc("materials");
  const doc = materials.doc;
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <MediaDocBar file="content/materials/materials.json" doc={materials} />
      {doc ? <MaterialsEditor doc={doc} onChange={materials.set} /> : <p className="text-[13px] opacity-70">{materials.loadError ?? "loading…"}</p>}
    </div>
  );
}

function MaterialsEditor({ doc, onChange }: { doc: MaterialsDoc; onChange: (d: MaterialsDoc) => void }): React.JSX.Element {
  const [events, setEvents] = React.useState<string[]>([]);
  const [night, setNight] = React.useState(false);
  const [row, setRow] = React.useState<Row>("cloth");
  React.useEffect(() => void getAudioEventNames().then(setEvents), []);
  const toon = doc.toon;
  const when = night ? "night" : "day";
  const setToon = (patch: Partial<MaterialsDoc["toon"]>): void => onChange({ ...doc, toon: { ...toon, ...patch } });
  const setEdge = (r: Row, i: 0 | 1, hex: string): void => {
    const pair: [Rgb, Rgb] = [...toon.ramp[r][when]];
    pair[i] = hexToLinear(hex);
    setToon({ ramp: { ...toon.ramp, [r]: { ...toon.ramp[r], [when]: pair } } });
  };
  const setSurface = (id: string, next: MaterialsDoc["surfaces"][string]): void => onChange({ ...doc, surfaces: { ...doc.surfaces, [id]: next } });
  return (
    <div className="flex flex-col gap-3">
      <Heading>Toon shading</Heading>
      <div className="flex flex-wrap items-end gap-3">
        <Num label="Shadow edge" value={toon.band[0]} min={0} max={1} step={0.01} onChange={(v) => setToon({ band: [v, toon.band[1]] })} />
        <Num label="Lit edge" value={toon.band[1]} min={0} max={1} step={0.01} onChange={(v) => setToon({ band: [toon.band[0], v] })} />
        <Num label="Highlight" value={toon.specular} min={0} max={1} step={0.01} onChange={(specular) => setToon({ specular })} />
        <Num label="Rim light" value={toon.rim} min={0} max={2} step={0.05} onChange={(rim) => setToon({ rim })} />
        <Num label="Rim power" value={toon.rimPower} min={0.5} max={32} step={0.5} onChange={(rimPower) => setToon({ rimPower })} />
        <CheckField label="Night ramp" checked={night} onChange={setNight} />
      </div>
      <div className="flex flex-wrap gap-4">
        <ToonBall toon={toon} row={row} night={night} />
        <div className="flex flex-col gap-2">
          {TOON_ROW_NAMES.map((r) => {
            const pair = toon.ramp[r][when];
            return (
              <div key={r} className="flex items-center gap-2" data-ramp={r}>
                <Button size="sm" variant={r === row ? "default" : "outline"} onClick={() => setRow(r)}>{r}</Button>
                <input type="color" aria-label={`${r} darkest shadow`} value={linearToHex(pair[0])} onChange={(e) => setEdge(r, 0, e.target.value)} />
                <input type="color" aria-label={`${r} shadow edge`} value={linearToHex(pair[1])} onChange={(e) => setEdge(r, 1, e.target.value)} />
                <span className="h-5 w-32 rounded" style={{ background: `linear-gradient(90deg, ${linearToHex(pair[0])}, ${linearToHex(pair[1])})` }} aria-hidden />
              </div>
            );
          })}
        </div>
      </div>
      <Heading>Footsteps</Heading>
      <div className="flex flex-wrap items-end gap-3">
        <Num label="Metres per step" unit="m" value={doc.footstepStride ?? 1.7} min={0.5} max={5} step={0.1} onChange={(footstepStride) => onChange({ ...doc, footstepStride })} />
        <p className="max-w-md text-[12px] opacity-70">A step sounds each stride walked on the ground; the audio event is the surface underfoot's, else "footstep".</p>
      </div>
      <Heading>Surfaces</Heading>
      <datalist id="step-events">{events.map((e) => <option key={e} value={e} />)}</datalist>
      <div className="flex flex-col gap-1.5">
        {Object.entries(doc.surfaces).map(([sid, s]) => (
          <div key={sid} className="flex flex-wrap items-end gap-2" data-surface={sid}>
            <span className="w-28 font-mono text-[12px]">{sid}</span>
            <span className="h-6 w-8 rounded" style={{ background: linearToHex(s.tint.map((v) => Math.min(1, v * 0.5)) as Rgb) }} aria-hidden />
            {([0, 1, 2] as const).map((i) => (
              <Num key={i} label={`${sid} tint ${"rgb"[i]}`} value={s.tint[i]} min={0} max={4} step={0.05} onChange={(v) => setSurface(sid, { ...s, tint: s.tint.map((x, k) => (k === i ? v : x)) as Rgb })} />
            ))}
            <Num label={`${sid} tile`} unit="m" value={s.tileMetres ?? NaN} min={0.1} step={0.5} onChange={(tileMetres) => setSurface(sid, { ...s, tileMetres })} />
            <Txt label={`${sid} footstep`} value={s.footstep ?? ""} list="step-events" onChange={(v) => setSurface(sid, withFootstep(s, v))} />
          </div>
        ))}
      </div>
    </div>
  );
}

function withFootstep(s: MaterialsDoc["surfaces"][string], v: string): MaterialsDoc["surfaces"][string] {
  const { footstep: _f, ...rest } = s;
  return v === "" ? rest : { ...rest, footstep: v };
}

/** A lit ball in the toon look, one band and ramp row at a time. */
function ToonBall({ toon, row, night }: { toon: MaterialsDoc["toon"]; row: Row; night: boolean }): React.JSX.Element {
  const ref = React.useRef<HTMLCanvasElement | null>(null);
  React.useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const n = c.width;
    const img = ctx.createImageData(n, n);
    const light = [0.55, 0.55, 0.63];
    const len = Math.hypot(...light);
    const base: Rgb = [0.85, 0.8, 0.75];
    const ramp = toon.ramp[row][night ? "night" : "day"];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const px = (x / (n - 1)) * 2 - 1;
        const py = 1 - (y / (n - 1)) * 2;
        const r2 = px * px + py * py;
        const o = (y * n + x) * 4;
        if (r2 > 1) continue;
        const nz = Math.sqrt(1 - r2);
        const hex = linearToHex(toonColour((px * light[0] + py * light[1] + nz * light[2]) / len, nz, base, ramp, toon));
        img.data[o] = parseInt(hex.slice(1, 3), 16);
        img.data[o + 1] = parseInt(hex.slice(3, 5), 16);
        img.data[o + 2] = parseInt(hex.slice(5, 7), 16);
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [toon, row, night]);
  return <canvas ref={ref} width={140} height={140} className="rounded-xl" style={{ width: 140, height: 140, background: "var(--m3-surface-0)" }} aria-label={`${row} toon preview`} />;
}
