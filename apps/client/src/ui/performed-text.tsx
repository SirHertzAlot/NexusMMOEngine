/**
 * PerformedText (roadmap CF5): a line performed from ui/text-performance.ts. Glyphs arrive on the clock with a pop,
 * [shake] and [wave] glyphs keep moving, glossary terms are coloured. The DOM is driven from one frame loop (the line
 * is not re-rendered per glyph) that stops when the line is typed and nothing moves. Under reduced motion the whole
 * line is simply there. The caller can finish the line at once through `control`.
 */
import * as React from "react";
import { DEFAULT_PERFORM, LinePerformance, glyphPose, schedule, type GlossaryTerm, type GlyphPose, type PerformRecipe } from "./text-performance.js";

export interface PerformedControl {
  /** Finish the line at once (a key or a click while it types). */
  complete(): void;
  readonly done: boolean;
}

export interface PerformedTextProps {
  text: string;
  glossary?: readonly GlossaryTerm[];
  recipe?: PerformRecipe;
  /** The line has finished typing. */
  onDone?: () => void;
  /** Every `recipe.blipEvery` glyphs while it types (a voice sound goes here). */
  onBlip?: () => void;
  /** The speaker's mouth: true while a glyph was just emitted. */
  onSpeaking?: (speaking: boolean) => void;
  control?: React.MutableRefObject<PerformedControl | null>;
  className?: string;
}

const reduced = (): boolean => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export function PerformedText({ text, glossary, recipe = DEFAULT_PERFORM, onDone, onBlip, onSpeaking, control, className }: PerformedTextProps): React.ReactElement {
  const instant = React.useMemo(reduced, []);
  const timeline = React.useMemo(() => schedule(text, recipe, glossary ?? [], instant), [text, recipe, glossary, instant]);
  const perf = React.useMemo(() => new LinePerformance(timeline.glyphs, timeline.total, recipe), [timeline, recipe]);
  const els = React.useRef<(HTMLSpanElement | null)[]>([]);
  const cb = React.useRef({ onDone, onBlip, onSpeaking });
  cb.current = { onDone, onBlip, onSpeaking };

  React.useEffect(() => {
    const pose: GlyphPose = { opacity: 0, scale: 1, dx: 0, dy: 0 };
    const moving = timeline.glyphs.some((g) => g.shake || g.wave);
    let raf = 0;
    let last = performance.now();
    let blips = 0;
    let wasDone = false;
    let wasSpeaking = false;
    const draw = (): void => {
      const g = timeline.glyphs;
      for (let i = 0; i < g.length; i++) {
        const el = els.current[i];
        if (!el) continue;
        glyphPose(g[i]!, i, perf.elapsed, recipe, pose);
        el.style.opacity = String(pose.opacity);
        // A space has nothing to move; a glyph that has settled and does not move needs no transform.
        el.style.transform = pose.scale !== 1 || pose.dx !== 0 || pose.dy !== 0 ? `translate(${pose.dx}px, ${pose.dy}px) scale(${pose.scale})` : "";
      }
    };
    const frame = (now: number): void => {
      const emitted = perf.advance(Math.min(100, now - last));
      last = now;
      blips += emitted;
      while (blips >= recipe.blipEvery) {
        blips -= recipe.blipEvery;
        cb.current.onBlip?.();
      }
      const speaking = perf.speaking;
      if (speaking !== wasSpeaking) cb.current.onSpeaking?.((wasSpeaking = speaking));
      draw();
      if (perf.done && !wasDone) {
        wasDone = true;
        cb.current.onDone?.();
      }
      raf = perf.done && !moving ? 0 : requestAnimationFrame(frame);
    };
    if (control) control.current = { complete: () => { perf.complete(); if (!raf) { draw(); if (!wasDone) { wasDone = true; cb.current.onDone?.(); } } }, get done() { return perf.done; } };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      if (control) control.current = null;
      if (wasSpeaking) cb.current.onSpeaking?.(false);
    };
  }, [timeline, perf, recipe, control]);

  // Words stay whole when the line wraps: each word is an unbreakable run of glyphs, spaces are the break points.
  const words: { start: number; end: number; space: boolean }[] = [];
  timeline.glyphs.forEach((g, i) => {
    const space = /\s/.test(g.ch);
    const last = words[words.length - 1];
    if (last && last.space === space && !space) last.end = i + 1;
    else words.push({ start: i, end: i + 1, space });
  });
  return (
    <span className={className} style={{ whiteSpace: "pre-wrap" }} aria-label={timeline.glyphs.map((g) => g.ch).join("")}>
      {words.map((w) => {
        const glyphs = timeline.glyphs.slice(w.start, w.end).map((g, k) => {
          const i = w.start + k;
          return (
            <span
              key={i}
              aria-hidden="true"
              ref={(el) => {
                els.current[i] = el;
              }}
              style={{ display: w.space ? "inline" : "inline-block", opacity: 0, ...(g.tone ? { color: recipe.tones[g.tone] } : {}), ...(g.tone ? { fontWeight: 600 } : {}) }}
            >
              {g.ch}
            </span>
          );
        });
        return w.space ? <React.Fragment key={w.start}>{glyphs}</React.Fragment> : <span key={w.start} style={{ display: "inline-block", whiteSpace: "nowrap" }}>{glyphs}</span>;
      })}
    </span>
  );
}
