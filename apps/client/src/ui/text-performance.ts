/**
 * Text performance (roadmap CF5): a dialogue line is performed, not printed.
 *
 *   line  -> TOKENISE  markup ([shake] [wave] [pause=ms]) and a glossary that colours names wherever they appear
 *         -> TYPE      glyphs emitted on a clock; punctuation adds dwell (a comma less than a sentence less than "...")
 *         -> PERFORM   per glyph: pop on arrival, shake, wave (Motion Grammar primitives)
 *         -> VOICE     `speaking` (a portrait's mouth) and a blip cadence follow emission
 *         -> AFFORD    the caller shows a continue arrow once `done`; input completes the line at once
 *
 * Everything tunable is the recipe. Pure: ui/performed-text.tsx draws it. Presentation only; the server sends the
 * line (and may send markup) and who is speaking.
 */

import { PRIMITIVES, makeOut, noise, type Step } from "../motion/index.js";

export interface PerformRecipe {
  /** Glyphs a second. */
  cps: number;
  /** Extra wait after punctuation, ms: a comma or semicolon, a full stop or question, an ellipsis. */
  dwell: { minor: number; major: number; ellipsis: number };
  /** Each glyph's arrival: scale from `from` up to `overshoot` and back to 1 over `ms`. */
  pop: { ms: number; from: number; overshoot: number };
  /** [shake]: px and Hz. */
  shake: { amp: number; freq: number };
  /** [wave]: px, rad/s along time, rad of phase between neighbours. */
  wave: { amp: number; speed: number; spread: number };
  /** The mouth stays open this long after a glyph is emitted, ms. */
  flapMs: number;
  /** One blip for every this many glyphs emitted. */
  blipEvery: number;
  /** Glossary tone -> colour. */
  tones: Record<string, string>;
}

export const DEFAULT_PERFORM: PerformRecipe = {
  cps: 38,
  dwell: { minor: 140, major: 320, ellipsis: 520 },
  pop: { ms: 110, from: 0.4, overshoot: 1.3 },
  shake: { amp: 1.4, freq: 28 },
  wave: { amp: 2.2, speed: 7, spread: 0.55 },
  flapMs: 90,
  blipEvery: 3,
  tones: { item: "#f59e0b", place: "#7dd3fc", omen: "#f87171", quest: "#fcd34d", person: "#a7f3d0" },
};

export interface Glyph {
  ch: string;
  /** When it is emitted, ms from the start. */
  at: number;
  shake: boolean;
  wave: boolean;
  /** A glossary tone, when it is part of a term. */
  tone?: string;
}

/** A name to colour wherever it appears: an item, a place, an omen, a quest, a person. */
export interface GlossaryTerm {
  term: string;
  tone: string;
}

interface Pending {
  ch: string;
  shake: boolean;
  wave: boolean;
  /** A [pause=ms] just before it. */
  pause: number;
  tone?: string;
}

const TAG = /^\[(\/?)(shake|wave)\]|^\[pause=(\d{1,5})\]/;
const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/** Read the markup; text in brackets that is not a tag stays text. */
export function tokenise(text: string, glossary: readonly GlossaryTerm[] = []): Pending[] {
  const out: Pending[] = [];
  let shake = false;
  let wave = false;
  let pause = 0;
  for (let i = 0; i < text.length; ) {
    if (text[i] === "[") {
      const m = TAG.exec(text.slice(i, i + 16));
      if (m) {
        if (m[3] !== undefined) pause += Number(m[3]);
        else if (m[2] === "shake") shake = m[1] === "";
        else wave = m[1] === "";
        i += m[0].length;
        continue;
      }
    }
    out.push({ ch: text[i]!, shake, wave, pause });
    pause = 0;
    i++;
  }
  // Glossary: whole-word, case-insensitive, longest term first, never overlapping.
  const plain = out.map((g) => g.ch).join("").toLowerCase();
  const taken = new Array<boolean>(out.length).fill(false);
  for (const t of [...glossary].sort((a, b) => b.term.length - a.term.length)) {
    const needle = t.term.toLowerCase();
    if (!needle) continue;
    for (let at = plain.indexOf(needle); at >= 0; at = plain.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (isWord(plain[at - 1]) || isWord(plain[end]) || taken.slice(at, end).some(Boolean)) continue;
      for (let k = at; k < end; k++) {
        out[k]!.tone = t.tone;
        taken[k] = true;
      }
    }
  }
  return out;
}

/** The wait after a glyph: punctuation only counts at the end of a word ("3.5" and "e.g." do not stop). */
function dwellAfter(chars: readonly Pending[], i: number, r: PerformRecipe): number {
  const c = chars[i]!.ch;
  const next = chars[i + 1]?.ch;
  const atEnd = next === undefined || /\s/.test(next);
  if (c === "…") return r.dwell.ellipsis;
  if (c === "." && chars[i - 1]?.ch === "." && chars[i - 2]?.ch === "." && atEnd) return r.dwell.ellipsis;
  if (c === "." && (chars[i - 1]?.ch === "." || next === ".")) return 0; // inside an ellipsis
  if (atEnd && (c === "." || c === "!" || c === "?")) return r.dwell.major;
  if (atEnd && (c === "," || c === ";" || c === ":")) return r.dwell.minor;
  return 0;
}

/** Put the glyphs on the clock. `instant` shows the whole line at once (reduced motion). */
export function schedule(text: string, recipe: PerformRecipe = DEFAULT_PERFORM, glossary: readonly GlossaryTerm[] = [], instant = false): { glyphs: Glyph[]; total: number } {
  const chars = tokenise(text, glossary);
  const step = 1000 / recipe.cps;
  const glyphs: Glyph[] = [];
  let t = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    t += instant ? 0 : c.pause;
    glyphs.push({ ch: c.ch, at: t, shake: c.shake && !instant, wave: c.wave && !instant, ...(c.tone ? { tone: c.tone } : {}) });
    if (!instant) t += (/\s/.test(c.ch) ? step * 0.6 : step) + dwellAfter(chars, i, recipe);
  }
  return { glyphs, total: instant ? 0 : t };
}

/** One performance: the clock over the scheduled glyphs. */
export class LinePerformance {
  elapsed = 0;
  private cursor = 0;
  constructor(readonly glyphs: readonly Glyph[], readonly total: number, private readonly recipe: PerformRecipe = DEFAULT_PERFORM) {}

  /** Glyphs emitted so far. */
  get shown(): number {
    while (this.cursor < this.glyphs.length && this.glyphs[this.cursor]!.at <= this.elapsed) this.cursor++;
    return this.cursor;
  }

  get done(): boolean {
    return this.elapsed >= this.total;
  }

  /** Advance by `dtMs`; returns how many glyphs were emitted by it (for the blip cadence). */
  advance(dtMs: number): number {
    const before = this.shown;
    this.elapsed += dtMs;
    return this.shown - before;
  }

  /** Input while it types finishes the line at once. */
  complete(): void {
    this.elapsed = Math.max(this.elapsed, this.total);
  }

  /** The mouth is open: a visible glyph was emitted within `flapMs`. */
  get speaking(): boolean {
    if (this.done) return false;
    for (let i = this.shown - 1; i >= 0; i--) {
      const g = this.glyphs[i]!;
      if (this.elapsed - g.at > this.recipe.flapMs) return false;
      if (!/\s/.test(g.ch)) return true;
    }
    return false;
  }
}

export interface GlyphPose {
  opacity: number;
  scale: number;
  dx: number;
  dy: number;
}

const POP: Step = { p: "pop" };
const out = makeOut();

/** Where glyph `i` is at `elapsed` ms: hidden before its turn, popping in, then shaking or waving if marked. */
export function glyphPose(g: Glyph, i: number, elapsed: number, r: PerformRecipe, into: GlyphPose): GlyphPose {
  const age = elapsed - g.at;
  if (age < 0) {
    into.opacity = 0;
    into.scale = 1;
    into.dx = into.dy = 0;
    return into;
  }
  into.opacity = 1;
  into.dx = into.dy = 0;
  into.scale = 1;
  if (age < r.pop.ms) {
    out.scale = 1;
    POP.from = r.pop.from;
    POP.overshoot = r.pop.overshoot;
    PRIMITIVES.pop!.apply(out, age, age / r.pop.ms, POP, i);
    into.scale = out.scale;
  }
  if (g.shake) {
    const n = Math.floor((elapsed / 1000) * r.shake.freq);
    into.dx += noise(i + 1, n) * r.shake.amp;
    into.dy += noise(i + 1, n + 977) * r.shake.amp;
  }
  if (g.wave) into.dy += Math.sin((elapsed / 1000) * r.wave.speed + i * r.wave.spread) * r.wave.amp;
  return into;
}

/** Quest names, reward items and giver names as glossary terms: what a quest-giver talks about, coloured wherever it appears. */
export function glossaryFrom(parts: { quests?: readonly string[]; items?: readonly string[]; people?: readonly string[]; places?: readonly string[] }): GlossaryTerm[] {
  const terms: GlossaryTerm[] = [];
  const add = (list: readonly string[] | undefined, tone: string): void => {
    for (const term of list ?? []) if (term.trim().length >= 3) terms.push({ term: term.trim(), tone });
  };
  add(parts.quests, "quest");
  add(parts.items, "item");
  add(parts.people, "person");
  add(parts.places, "place");
  return terms;
}
