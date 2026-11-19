/**
 * Meter — the shared bar UI for the client (U2's PlayerFrame today,
 * stamina/mana tomorrow, anything else that needs a value/max bar).
 *
 * Props-driven: callers pass their own data, so no bar is ever
 * re-implemented per consumer. For sparklines and segmented LOD views,
 * see ui/perf-hud.tsx instead — different visualisations, not bars.
 *
 * `readout` turns on the vitals readout (CF2, ui/vitals.ts): the fill
 * drains to the true value, a ghost chunk shows what the last hit cost, the
 * colour follows the % bands, and the bar flashes, punches and shakes
 * through the Motion Grammar. It drives the DOM straight from a frame loop
 * that runs only while something moves, so a hit does not re-render React.
 */
import * as React from "react";
import { MotionSystem, makeOut, type Recipe } from "../motion/index.js";
import { DEFAULT_VITALS, bandColor, newVitals, observeVitals, stepVitals, type VitalsState } from "./vitals.js";

const TONES: Record<string, string> = {
  health: "bg-red-500",
  stamina: "bg-green-500",
  mana: "bg-sky-500",
  hunger: "bg-amber-500",
  thirst: "bg-cyan-400",
};

/** Fraction of a bar to fill, clamped to [0, 1]; non-positive maxima fill nothing. */
export function barFraction(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(1, value / max));
}

export interface BarProps {
  label: string;
  value: number;
  max: number;
  tone: keyof typeof TONES;
  /** Vitals readout: drain, ghost, bands and hit reactions (health bars). */
  readout?: boolean;
}

const HIT_SMALL: Recipe = { steps: [{ p: "flash", ms: 140, amount: 0.7 }] };
const HIT_BIG: Recipe = { steps: [{ p: "flash", ms: 180, amount: 0.9 }, { p: "punch", ms: 160, amp: 0.12, shake: 2.5, parallel: true }] };
const HEAL: Recipe = { steps: [{ p: "flash", ms: 260, amount: 0.5 }] };

function Label({ label, value, max }: Pick<BarProps, "label" | "value" | "max">): React.ReactElement {
  return (
    <div className="mb-0.5 flex justify-between text-[11px] text-muted-foreground">
      <span>{label}</span>
      <span className="tabular-nums">
        {Math.max(0, Math.round(value))}/{Math.max(0, Math.round(max))}
      </span>
    </div>
  );
}

function PlainBar({ label, value, max, tone }: BarProps): React.ReactElement {
  const pct = barFraction(value, max) * 100;
  return (
    <div>
      <Label label={label} value={value} max={max} />
      <div
        className="h-2 w-full overflow-hidden rounded bg-secondary"
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.max(0, Math.round(value))}
        aria-valuemax={Math.max(0, Math.round(max))}
      >
        <div className={`h-full rounded ${TONES[tone]}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ReadoutBar({ label, value, max }: BarProps): React.ReactElement {
  const truth = barFraction(value, max);
  const box = React.useRef<HTMLDivElement>(null);
  const fill = React.useRef<HTMLDivElement>(null);
  const ghost = React.useRef<HTMLDivElement>(null);
  const flash = React.useRef<HTMLDivElement>(null);
  const st = React.useRef<VitalsState>(newVitals(truth));
  const motion = React.useRef<MotionSystem>(new MotionSystem(2));
  const handle = React.useRef(-1);
  const raf = React.useRef(0);
  const last = React.useRef(0);
  const out = React.useRef(makeOut());

  const frame = React.useCallback((now: number): void => {
    const dt = Math.min(0.1, (now - last.current) / 1000);
    last.current = now;
    const s = st.current;
    const m = motion.current;
    m.tick(dt);
    const moving = stepVitals(s, dt, DEFAULT_VITALS);
    const live = m.sample(handle.current, out.current);
    if (fill.current) {
      fill.current.style.width = `${s.shown * 100}%`;
      fill.current.style.backgroundColor = bandColor(s.shown, DEFAULT_VITALS.bands);
    }
    if (ghost.current) ghost.current.style.width = `${s.ghost * 100}%`;
    if (box.current) {
      const o = out.current;
      box.current.style.transform = live ? `translate(${o.dx}px, ${o.dy}px) scale(${o.scale})` : "";
    }
    if (flash.current) flash.current.style.opacity = live ? String(out.current.flash) : "0";
    raf.current = moving || live ? requestAnimationFrame(frame) : 0;
  }, []);

  React.useEffect(() => () => cancelAnimationFrame(raf.current), []);

  React.useEffect(() => {
    const d = observeVitals(st.current, truth, DEFAULT_VITALS);
    if (d !== 0) {
      motion.current.stop(handle.current);
      handle.current = motion.current.start(d > 0 ? HEAL : -d >= DEFAULT_VITALS.bigHit ? HIT_BIG : HIT_SMALL);
    }
    if (!raf.current) {
      last.current = performance.now();
      raf.current = requestAnimationFrame(frame);
    }
  }, [truth, frame]);

  const s0 = st.current;
  return (
    <div>
      <Label label={label} value={value} max={max} />
      <div
        ref={box}
        className="relative h-2 w-full overflow-hidden rounded bg-secondary"
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.max(0, Math.round(value))}
        aria-valuemax={Math.max(0, Math.round(max))}
      >
        <div ref={ghost} className="absolute inset-y-0 left-0 rounded bg-white/60" style={{ width: `${s0.ghost * 100}%` }} />
        <div ref={fill} className="absolute inset-y-0 left-0 rounded" style={{ width: `${s0.shown * 100}%`, backgroundColor: bandColor(s0.shown, DEFAULT_VITALS.bands) }} />
        <div ref={flash} className="absolute inset-0 bg-white" style={{ opacity: 0 }} />
      </div>
    </div>
  );
}

function BarImpl(props: BarProps): React.ReactElement {
  return props.readout ? <ReadoutBar {...props} /> : <PlainBar {...props} />;
}

export const Bar = React.memo(BarImpl);
Bar.displayName = "Bar";
