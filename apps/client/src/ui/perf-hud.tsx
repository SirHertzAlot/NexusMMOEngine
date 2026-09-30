/**
 * PerfHud — the world screen's performance panel: what each frame costs
 * and where it goes, compact enough to leave on.
 *
 * Each measure is one row: its name, a sparkline of the last minute
 * (perf-stats.ts samples it once a second), and its value now. Pointing
 * at any graph moves one crosshair across all of them, and every row's
 * value reads that second instead, so a spike in frame time lines up with
 * the draw calls, triangles and traffic of the same moment. Props get a
 * bar of how many are drawn at each level of detail.
 */

import { useState } from "react";
import { bytes, compact, type PerfSample } from "../render/perf-stats.js";

const W = 88;
const H = 18;
/** The line colour (sky-400) and the secondary one for a row's worst case (slate-500). */
const LINE = "#38bdf8";
const MUTED = "#64748b";
/** Levels of detail, full detail darkest (one hue, light by distance). */
const LEVEL_FILL = ["#0369a1", "#0ea5e9", "#7dd3fc", "#e0f2fe"];

interface Row {
  label: string;
  value: (s: PerfSample) => number;
  /** A second line on the same scale (a worst case), drawn muted. */
  peak?: (s: PerfSample) => number;
  format: (s: PerfSample) => string;
  title: string;
}

const ROWS: Row[] = [
  { label: "fps", value: (s) => s.fps, format: (s) => `${Math.round(s.fps)}`, title: "Frames drawn in the second" },
  {
    label: "frame",
    value: (s) => s.frameMs,
    peak: (s) => s.frameMaxMs,
    format: (s) => `${s.frameMs.toFixed(1)} ms · ${Math.round(s.frameMaxMs)} max`,
    title: "Mean frame time, and the slowest frame of the second (grey)",
  },
  {
    label: "draws",
    value: (s) => s.drawCalls,
    format: (s) => `${Math.round(s.drawCalls)} · props ${s.propDrawCalls}`,
    title: "Draw calls a frame, over every pass (scene, shadows, screen effects); props: their instanced batches",
  },
  {
    label: "tris",
    value: (s) => s.triangles,
    format: (s) => `${compact(s.triangles)} · props ${compact(s.propTriangles)}`,
    title: "Triangles a frame, over every pass; props: the scenery's share",
  },
  {
    label: "net in",
    value: (s) => s.inBytesPerSec,
    format: (s) => `${bytes(s.inBytesPerSec)}/s`,
    title: "Received from the server, a second",
  },
  {
    label: "net out",
    value: (s) => s.outBytesPerSec,
    format: (s) => `${bytes(s.outBytesPerSec)}/s`,
    title: "Sent to the server, a second",
  },
  {
    label: "heap",
    value: (s) => s.heapBytes ?? 0,
    format: (s) => (s.heapBytes === null ? "n/a" : bytes(s.heapBytes)),
    title: "JavaScript heap in use (Chromium only)",
  },
];

export function PerfHud({ samples }: { samples: PerfSample[] }): React.ReactElement | null {
  // The sample under the pointer (index into samples), shared by every graph.
  const [hover, setHover] = useState<number | null>(null);
  if (samples.length === 0) return null;
  const at = hover !== null && hover < samples.length ? hover : samples.length - 1;
  const s = samples[at];
  const ago = samples.length - 1 - at;
  const saved = s.propFullTriangles > 0 ? 1 - s.propTriangles / s.propFullTriangles : 0;
  return (
    <div className="text-xs tabular-nums">
      <div className="mb-1 flex justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>last {samples.length}s</span>
        <span>{ago === 0 ? "now" : `${ago}s ago`}</span>
      </div>
      <div className="grid grid-cols-[3.5rem_minmax(48px,1fr)_auto] items-center gap-x-2 gap-y-0.5">
        {ROWS.filter((r) => r.label !== "heap" || s.heapBytes !== null).map((r) => (
          <div key={r.label} className="contents">
            <span className="text-muted-foreground" title={r.title}>
              {r.label}
            </span>
            <Sparkline samples={samples} value={r.value} peak={r.peak} at={hover === null ? null : at} onHover={setHover} />
            <span className="whitespace-nowrap text-foreground">{r.format(s)}</span>
          </div>
        ))}
        <span className="text-muted-foreground" title="Props drawn at each level of detail (full detail first)">
          lod
        </span>
        <LevelBar perLevel={s.propsPerLevel} />
        <span className="whitespace-nowrap text-foreground" title="Prop triangles saved by the lighter levels">
          {s.props} props · −{Math.round(saved * 100)}%
        </span>
      </div>
      <div className="mt-1 text-muted-foreground" title="What the GPU holds, and the world's size">
        geo <span className="text-foreground">{s.geometries}</span> · tex{" "}
        <span className="text-foreground">{s.textures}</span> · shaders{" "}
        <span className="text-foreground">{s.programs}</span> · ents{" "}
        <span className="text-foreground">{s.entities}</span> · chunks{" "}
        <span className="text-foreground">{s.chunks}</span>
      </div>
    </div>
  );
}

/** A minute of one measure, from zero, stretched to its column; `at` draws the shared crosshair. */
function Sparkline({
  samples,
  value,
  peak,
  at,
  onHover,
}: {
  samples: PerfSample[];
  value: (s: PerfSample) => number;
  peak?: (s: PerfSample) => number;
  at: number | null;
  onHover: (i: number | null) => void;
}): React.ReactElement {
  const values = samples.map(value);
  const peaks = peak ? samples.map(peak) : null;
  const top = Math.max(1e-9, ...values, ...(peaks ?? [])) * 1.1;
  // The newest sample on the right edge; one sample a step.
  const step = W / Math.max(1, samples.length - 1);
  const x = (i: number): number => (samples.length === 1 ? W : i * step);
  const y = (v: number): number => H - 1 - (v / top) * (H - 2);
  const path = (vs: number[]): string => vs.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg
      width="100%"
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="block cursor-crosshair"
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onHover(Math.max(0, Math.min(samples.length - 1, Math.round(((e.clientX - r.left) / r.width) * W / step))));
      }}
      onMouseLeave={() => onHover(null)}
    >
      <line x1={0} y1={H - 0.5} x2={W} y2={H - 0.5} stroke={MUTED} strokeOpacity={0.35} vectorEffect="non-scaling-stroke" />
      {peaks && <polyline points={path(peaks)} fill="none" stroke={MUTED} strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
      <polyline points={path(values)} fill="none" stroke={LINE} strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {at !== null && (
        <line x1={x(at)} y1={0} x2={x(at)} y2={H} stroke="#e2e8f0" strokeOpacity={0.6} vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}

/** Props at each level of detail, as one bar split by level (2px gaps between segments). */
function LevelBar({ perLevel }: { perLevel: number[] }): React.ReactElement {
  const total = perLevel.reduce((a, b) => a + b, 0);
  const gaps = Math.max(0, perLevel.filter((n) => n > 0).length - 1) * 2;
  let left = 0;
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block">
      {total === 0 ? (
        <rect x={0} y={5} width={W} height={8} rx={2} fill={MUTED} fillOpacity={0.35} />
      ) : (
        perLevel.map((n, i) => {
          if (n === 0) return null;
          const w = ((W - gaps) * n) / total;
          const r = (
            <rect key={i} x={left} y={5} width={Math.max(1, w)} height={8} rx={2} fill={LEVEL_FILL[Math.min(i, LEVEL_FILL.length - 1)]}>
              <title>{`level ${i}${i === 0 ? " (full detail)" : ""}: ${n} props`}</title>
            </rect>
          );
          left += w + 2;
          return r;
        })
      )}
    </svg>
  );
}
