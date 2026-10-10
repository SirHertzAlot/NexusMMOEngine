/**
 * Automated playtests (roadmap EA26): the scenario document, its
 * validation, the assertions, and the replay and result records.
 *
 * Pure data and pure functions, shared by the dev host (which runs a
 * scenario against a scratch server) and the Playtests panel (which edits
 * and shows them). A scenario lives in `content/playtests/<name>.playtest.json`.
 *
 * A scenario is a bot script (inputs at server ticks counted from the
 * start of the run), a seed and bot count for the scratch world, and
 * assertions over what the run saw. A run records every input it sent as a
 * replay; running the replay re-sends the same inputs at the same ticks
 * into a world of the same seed, so a failure can be reproduced and the
 * two position traces compared tick by tick.
 */

export const PLAYTEST_NAME = /^[a-z][a-z0-9-]{0,47}$/;
export const MAX_DURATION_TICKS = 18_000;
export const MAX_BOTS = 200;
export const MAX_HISTORY = 50;

export type PlaytestStep =
  | { at: number; do: "admin"; command: string; args?: Record<string, unknown>; expectOk?: boolean }
  | { at: number; do: "move"; mx: number; mz: number; ticks: number; jump?: boolean }
  | { at: number; do: "stop" }
  | { at: number; do: "chat"; text: string; channel?: "say" | "yell" };

export type PlaytestAssertion =
  | { kind: "connected" }
  | { kind: "no-errors" }
  | { kind: "tick-p99-ms"; max: number }
  | { kind: "moved"; min: number }
  | { kind: "stays-within"; max: number }
  | { kind: "admin-ok" }
  | { kind: "admin-reply-contains"; step: number; text: string };

export interface PlaytestScenario {
  version: 1;
  name: string;
  description?: string;
  seed: number;
  bots: number;
  durationTicks: number;
  script: PlaytestStep[];
  assertions: PlaytestAssertion[];
}

export interface PlaytestIssue {
  path: string;
  message: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function checkKeys(o: Record<string, unknown>, allowed: string[], path: string, out: PlaytestIssue[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) out.push({ path: `${path}.${k}`, message: "unknown field" });
}

function checkStep(s: unknown, path: string, duration: number, out: PlaytestIssue[]): void {
  if (!isObj(s)) return void out.push({ path, message: "a step is an object" });
  if (!isInt(s.at, 0, MAX_DURATION_TICKS)) out.push({ path: `${path}.at`, message: `at is a whole tick from 0 to ${MAX_DURATION_TICKS}` });
  else if (s.at > duration) out.push({ path: `${path}.at`, message: `at ${s.at} is after durationTicks ${duration}; the step would never run` });
  switch (s.do) {
    case "admin":
      checkKeys(s, ["at", "do", "command", "args", "expectOk"], path, out);
      if (typeof s.command !== "string" || !/^[a-z]+$/.test(s.command)) out.push({ path: `${path}.command`, message: "command is a lowercase admin command name" });
      if (s.args !== undefined && !isObj(s.args)) out.push({ path: `${path}.args`, message: "args is an object" });
      if (s.expectOk !== undefined && typeof s.expectOk !== "boolean") out.push({ path: `${path}.expectOk`, message: "expectOk is true or false" });
      break;
    case "move":
      checkKeys(s, ["at", "do", "mx", "mz", "ticks", "jump"], path, out);
      for (const k of ["mx", "mz"] as const) if (!isNum(s[k]) || Math.abs(s[k]) > 1) out.push({ path: `${path}.${k}`, message: `${k} is a number from -1 to 1` });
      if (!isInt(s.ticks, 1, MAX_DURATION_TICKS)) out.push({ path: `${path}.ticks`, message: "ticks is a whole number of ticks to hold the move" });
      if (s.jump !== undefined && typeof s.jump !== "boolean") out.push({ path: `${path}.jump`, message: "jump is true or false" });
      break;
    case "stop":
      checkKeys(s, ["at", "do"], path, out);
      break;
    case "chat":
      checkKeys(s, ["at", "do", "text", "channel"], path, out);
      if (typeof s.text !== "string" || s.text.length < 1 || s.text.length > 200) out.push({ path: `${path}.text`, message: "text is 1 to 200 characters" });
      if (s.channel !== undefined && s.channel !== "say" && s.channel !== "yell") out.push({ path: `${path}.channel`, message: "channel is say or yell" });
      break;
    default:
      out.push({ path: `${path}.do`, message: "do is admin, move, stop or chat" });
  }
}

function checkAssertion(a: unknown, path: string, script: unknown[], out: PlaytestIssue[]): void {
  if (!isObj(a)) return void out.push({ path, message: "an assertion is an object" });
  switch (a.kind) {
    case "connected":
    case "no-errors":
    case "admin-ok":
      checkKeys(a, ["kind"], path, out);
      break;
    case "tick-p99-ms":
    case "stays-within":
      checkKeys(a, ["kind", "max"], path, out);
      if (!isNum(a.max) || a.max <= 0) out.push({ path: `${path}.max`, message: "max is a number above 0" });
      break;
    case "moved":
      checkKeys(a, ["kind", "min"], path, out);
      if (!isNum(a.min) || a.min < 0) out.push({ path: `${path}.min`, message: "min is a distance of 0 or more" });
      break;
    case "admin-reply-contains":
      checkKeys(a, ["kind", "step", "text"], path, out);
      if (!isInt(a.step, 0, 10_000) || a.step >= script.length || !isObj(script[a.step]) || (script[a.step] as { do?: unknown }).do !== "admin") {
        out.push({ path: `${path}.step`, message: "step is the index of an admin step in the script" });
      }
      if (typeof a.text !== "string" || a.text === "") out.push({ path: `${path}.text`, message: "text is the words the reply must contain" });
      break;
    default:
      out.push({ path: `${path}.kind`, message: "kind is connected, no-errors, tick-p99-ms, moved, stays-within, admin-ok or admin-reply-contains" });
  }
}

/** Every problem in a scenario document (empty = valid). `name` is the file's name when known. */
export function validatePlaytest(doc: unknown, name?: string): PlaytestIssue[] {
  const out: PlaytestIssue[] = [];
  if (!isObj(doc)) return [{ path: "", message: "a scenario is a JSON object" }];
  checkKeys(doc, ["version", "name", "description", "seed", "bots", "durationTicks", "script", "assertions"], "", out);
  if (doc.version !== 1) out.push({ path: "version", message: "version is 1" });
  if (typeof doc.name !== "string" || !PLAYTEST_NAME.test(doc.name)) out.push({ path: "name", message: "name is lowercase letters, digits and dashes, starting with a letter" });
  else if (name !== undefined && doc.name !== name) out.push({ path: "name", message: `name must match the file (${name})` });
  if (doc.description !== undefined && typeof doc.description !== "string") out.push({ path: "description", message: "description is text" });
  if (!isInt(doc.seed, 0, 0x7fffffff)) out.push({ path: "seed", message: "seed is a whole number from 0 to 2147483647" });
  if (!isInt(doc.bots, 0, MAX_BOTS)) out.push({ path: "bots", message: `bots is a whole number from 0 to ${MAX_BOTS}` });
  if (!isInt(doc.durationTicks, 1, MAX_DURATION_TICKS)) out.push({ path: "durationTicks", message: `durationTicks is a whole number from 1 to ${MAX_DURATION_TICKS}` });
  const duration = isInt(doc.durationTicks, 1, MAX_DURATION_TICKS) ? doc.durationTicks : MAX_DURATION_TICKS;
  if (!Array.isArray(doc.script)) out.push({ path: "script", message: "script is a list of steps" });
  else doc.script.forEach((s, i) => checkStep(s, `script[${i}]`, duration, out));
  if (!Array.isArray(doc.assertions) || doc.assertions.length === 0) out.push({ path: "assertions", message: "assertions is a list with at least one assertion" });
  else doc.assertions.forEach((a, i) => checkAssertion(a, `assertions[${i}]`, Array.isArray(doc.script) ? doc.script : [], out));
  return out;
}

// ------------------------------------------------------------------ inputs

export interface IntentInput {
  mx: number; my: number; mz: number; lookYaw: number; lookPitch: number; jump: boolean; buttons: number;
}

/** One thing the bot did, at a tick counted from the run's start. `step` is the script index it came from. */
export type ReplayInput =
  | { tick: number; step: number; kind: "intent"; intent: IntentInput }
  | { tick: number; step: number; kind: "admin"; command: string; args?: Record<string, unknown>; expectOk: boolean }
  | { tick: number; step: number; kind: "chat"; channel: "say" | "yell"; text: string };

const intent = (mx: number, mz: number, jump: boolean): IntentInput => ({ mx, my: 0, mz, lookYaw: 0, lookPitch: 0, jump, buttons: 0 });

/** The script as the raw inputs it sends, in tick order (stable for equal ticks). */
export function expandScript(script: PlaytestStep[]): ReplayInput[] {
  const out: ReplayInput[] = [];
  script.forEach((s, step) => {
    if (s.do === "admin") out.push({ tick: s.at, step, kind: "admin", command: s.command, ...(s.args ? { args: s.args } : {}), expectOk: s.expectOk ?? true });
    else if (s.do === "move") {
      out.push({ tick: s.at, step, kind: "intent", intent: intent(s.mx, s.mz, s.jump ?? false) });
      out.push({ tick: s.at + s.ticks, step, kind: "intent", intent: intent(0, 0, false) });
    } else if (s.do === "stop") out.push({ tick: s.at, step, kind: "intent", intent: intent(0, 0, false) });
    else out.push({ tick: s.at, step, kind: "chat", channel: s.channel ?? "say", text: s.text });
  });
  return out.sort((a, b) => a.tick - b.tick);
}

// ----------------------------------------------------------------- results

export interface TracePoint { tick: number; x: number; z: number }

/** What a run saw, for the assertions. */
export interface RunMetrics {
  ticks: number;
  connected: boolean;
  errors: string[];
  adminReplies: Array<{ step: number; ok: boolean; expectOk: boolean; message: string }>;
  trace: TracePoint[];
  tickP99Ms: number | null;
}

export interface AssertionResult {
  assertion: PlaytestAssertion;
  label: string;
  ok: boolean;
  actual: string;
}

const dist = (a: TracePoint, b: TracePoint): number => Math.hypot(a.x - b.x, a.z - b.z);
const fmt = (n: number): string => (Math.round(n * 100) / 100).toString();

export function assertionLabel(a: PlaytestAssertion): string {
  switch (a.kind) {
    case "connected": return "stays connected";
    case "no-errors": return "no server errors";
    case "tick-p99-ms": return `tick p99 < ${a.max} ms`;
    case "moved": return `moves at least ${a.min}`;
    case "stays-within": return `stays within ${a.max} of the start`;
    case "admin-ok": return "admin commands answer as expected";
    case "admin-reply-contains": return `step ${a.step} reply contains "${a.text}"`;
  }
}

export function evaluateAssertions(assertions: PlaytestAssertion[], m: RunMetrics): AssertionResult[] {
  const first = m.trace[0];
  const farthest = first ? Math.max(0, ...m.trace.map((p) => dist(first, p))) : 0;
  return assertions.map((a): AssertionResult => {
    const label = assertionLabel(a);
    const done = (ok: boolean, actual: string): AssertionResult => ({ assertion: a, label, ok, actual });
    switch (a.kind) {
      case "connected": return done(m.connected, m.connected ? "connected" : "dropped");
      case "no-errors": return done(m.errors.length === 0, m.errors.length === 0 ? "none" : m.errors[0]);
      case "tick-p99-ms":
        return m.tickP99Ms === null ? done(false, "no tick data") : done(m.tickP99Ms < a.max, `${fmt(m.tickP99Ms)} ms`);
      case "moved": return done(farthest >= a.min, `${fmt(farthest)}`);
      case "stays-within": return done(farthest <= a.max, `${fmt(farthest)}`);
      case "admin-ok": {
        const bad = m.adminReplies.filter((r) => r.ok !== r.expectOk);
        return done(bad.length === 0, bad.length === 0 ? `${m.adminReplies.length} ok` : `step ${bad[0].step}: ${bad[0].message}`);
      }
      case "admin-reply-contains": {
        const r = m.adminReplies.find((x) => x.step === a.step);
        return done(r !== undefined && r.message.includes(a.text), r ? r.message.slice(0, 80) : "step never ran");
      }
    }
  });
}

export interface PlaytestReplay {
  version: 1;
  id: string;
  scenario: string;
  seed: number;
  bots: number;
  durationTicks: number;
  inputs: ReplayInput[];
  assertions: PlaytestAssertion[];
  /** The position trace the original run recorded, to compare a re-run against. */
  trace: TracePoint[];
}

export interface PlaytestRun {
  id: string;
  scenario: string;
  at: string;
  mode: "run" | "replay";
  ok: boolean;
  ticks: number;
  wallMs: number;
  results: AssertionResult[];
  tickP99Ms: number | null;
  /** Set when the run could not finish (server did not start, dropped, ...). */
  error?: string;
  /** The replay this run saved or replayed. */
  replay?: string;
  /** Replays only: the first tick the position trace left the original, or null when it matched. */
  divergedAtTick?: number | null;
}

/** First tick at which two traces differ by more than `tol` world units; null when they match for the whole shorter length. */
export function firstDivergence(a: TracePoint[], b: TracePoint[], tol = 0.5): number | null {
  const byTick = new Map(b.map((p) => [p.tick, p]));
  for (const p of a) {
    const q = byTick.get(p.tick);
    if (q && dist(p, q) > tol) return p.tick;
  }
  return null;
}

/** Newest first, capped. */
export function pushHistory(history: PlaytestRun[], run: PlaytestRun): PlaytestRun[] {
  return [run, ...history].slice(0, MAX_HISTORY);
}

/** Pass rate of the newest `n` runs, 0..100 (null with no runs). */
export function passRate(history: PlaytestRun[], n = 10): number | null {
  const h = history.slice(0, n);
  return h.length === 0 ? null : Math.round((100 * h.filter((r) => r.ok).length) / h.length);
}

export const BLANK_SCENARIO = (name: string): PlaytestScenario => ({
  version: 1,
  name,
  description: "",
  seed: 1234,
  bots: 0,
  durationTicks: 150,
  script: [
    { at: 0, do: "admin", command: "whoami" },
    { at: 10, do: "move", mx: 0, mz: 1, ticks: 60 },
  ],
  assertions: [{ kind: "connected" }, { kind: "no-errors" }, { kind: "admin-ok" }, { kind: "moved", min: 1 }],
});
