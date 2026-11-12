/**
 * ChoreoMenu (roadmap CF3): a list of items choreographed from a theme
 * (ui/choreo.ts). Controlled: the caller owns `focused`. Items cascade in
 * with a stagger, the focused one grows and fills with the theme colour
 * while the rest dim and drift, and activation punches. Arrow keys move
 * focus, Enter or a double-click confirms.
 *
 * Like the vitals Bar it drives the DOM from one frame loop instead of
 * re-rendering React per frame, and the loop stops when nothing moves.
 */
import * as React from "react";
import { MotionSystem, makeOut, type Recipe } from "../motion/index.js";
import { DEFAULT_THEME, itemOffset, moveFocus, newTreat, rarityStyle, stepTreat, type MenuTheme, type Treat } from "./choreo.js";

export interface ChoreoItem {
  key: string | number;
  label: React.ReactNode;
  /** Rarity tier: colours the item and gives it a sheen (theme.rarity). */
  rarity?: string;
  disabled?: boolean;
}

export interface ChoreoMenuProps {
  items: ChoreoItem[];
  focused: number | null;
  onFocus: (i: number) => void;
  onConfirm: (i: number) => void;
  theme?: MenuTheme;
  /** Classes for each item (layout, border, padding). */
  itemClass?: string;
  className?: string;
  "aria-label"?: string;
}

export function ChoreoMenu({ items, focused, onFocus, onConfirm, theme = DEFAULT_THEME, itemClass = "", className = "", ...rest }: ChoreoMenuProps): React.ReactElement {
  const els = React.useRef<(HTMLButtonElement | null)[]>([]);
  const treats = React.useRef<Treat[]>([]);
  const motion = React.useRef<MotionSystem>(new MotionSystem(2));
  const enter = React.useRef<number[]>([]);
  const confirm = React.useRef<number[]>([]);
  const focusRef = React.useRef(focused);
  focusRef.current = focused;
  const themeRef = React.useRef(theme);
  themeRef.current = theme;
  const raf = React.useRef(0);
  const last = React.useRef(0);
  const outA = React.useRef(makeOut());
  const outB = React.useRef(makeOut());
  const keys = items.map((i) => i.key).join("|");

  const frame = React.useCallback((now: number): void => {
    const dt = Math.min(0.1, (now - last.current) / 1000);
    last.current = now;
    const th = themeRef.current;
    const m = motion.current;
    const n = els.current.length;
    m.tick(dt);
    let moving = m.activeCount > 0;
    for (let i = 0; i < n; i++) {
      const el = els.current[i];
      const tr = treats.current[i];
      if (!el || !tr) continue;
      if (stepTreat(tr, i === focusRef.current, th.focus.rate, dt)) moving = true;
      const f = tr.focus;
      const a = m.sample(enter.current[i] ?? -1, outA.current);
      const c = m.sample(confirm.current[i] ?? -1, outB.current);
      const base = itemOffset(th.motif, i, n, th.motifStep);
      const oa = outA.current;
      const oc = outB.current;
      const dx = base.x + f * th.focus.offsetX + (a ? oa.dx * (1 - f) : 0) + (c ? oc.dx : 0);
      const dy = base.y + (a ? oa.dy * (1 - f) : 0) + (c ? oc.dy : 0);
      const sc = (1 + (th.focus.scale - 1) * f) * (a ? oa.scale : 1) * (c ? oc.scale : 1);
      el.style.transform = `translate(${dx}px, ${dy}px) scale(${sc})`;
      el.style.opacity = String((1 - (1 - th.focus.dim) * (1 - f)) * (a ? oa.alpha : 1));
      const mix = Math.max(f, c ? oc.flash : 0);
      el.style.backgroundColor = mix > 0.002 ? `color-mix(in srgb, ${th.color} ${mix * 100}%, transparent)` : "";
      el.style.color = th.focus.invert && mix > 0.5 ? "#0b0b10" : "";
      el.style.borderColor = f > 0.01 ? th.color : "";
    }
    raf.current = moving ? requestAnimationFrame(frame) : 0;
  }, []);

  const wake = React.useCallback((): void => {
    if (!raf.current) {
      last.current = performance.now();
      raf.current = requestAnimationFrame(frame);
    }
  }, [frame]);

  // ENTER: a fresh set of items cascades in, one stagger apart (then drifts at rest).
  React.useEffect(() => {
    const n = items.length;
    const m = new MotionSystem(Math.max(2, n * 2));
    motion.current = m;
    const idle = theme.idle.amp > 0 ? [{ p: "sineIdle", amp: theme.idle.amp, freq: theme.idle.freq, seedPhase: 1.3 }] : [];
    const recipe: Recipe = { staggerMs: theme.staggerMs, steps: [...theme.enter.steps, ...idle] };
    treats.current = items.map((_, i) => newTreat(i === focusRef.current));
    enter.current = items.map((_, i) => m.start(recipe, { index: i, seed: i + 1 }));
    confirm.current = items.map(() => -1);
    wake();
    return () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, theme.staggerMs, theme.idle.amp, theme.idle.freq]);

  React.useEffect(wake, [focused, theme.color, wake]);

  const activate = (i: number): void => {
    if (items[i]?.disabled) return;
    motion.current.stop(confirm.current[i] ?? -1);
    confirm.current[i] = motion.current.start(theme.confirm);
    wake();
    onConfirm(i);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const dir = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (dir) {
      e.preventDefault();
      const next = moveFocus(focused ?? -1, dir, items.length);
      if (next >= 0) {
        onFocus(next);
        els.current[next]?.focus();
      }
    } else if (e.key === "Enter" && focused !== null && focused >= 0) {
      e.preventDefault();
      activate(focused);
    }
  };

  return (
    <div
      role="listbox"
      className={className}
      style={theme.slantDeg ? { transform: `skewX(${-theme.slantDeg}deg)` } : undefined}
      onKeyDown={onKeyDown}
      {...rest}
    >
      {items.map((it, i) => {
        const r = it.rarity ? rarityStyle(theme, it.rarity) : null;
        return (
          <button
            key={it.key}
            ref={(el) => {
              els.current[i] = el;
            }}
            role="option"
            aria-selected={i === focused}
            disabled={it.disabled}
            className={itemClass}
            style={{ opacity: 0, ...(r ? { boxShadow: `inset 0 0 14px color-mix(in srgb, ${r.color} ${Math.round(r.sheen * 100)}%, transparent)`, borderLeft: `3px solid ${r.color}` } : null) }}
            onClick={() => onFocus(i)}
            onDoubleClick={() => activate(i)}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
