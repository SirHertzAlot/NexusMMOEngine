/**
 * Plays a list of recorded inputs through a bot session and collects what
 * the assertions need. The session is a narrow interface so this runs
 * against a fake in tests and against a real MirrorClient in the host
 * (playtest-server.ts). A normal run feeds it `expandScript(script)`; a
 * replay feeds it the inputs the original run recorded.
 */
import {
  evaluateAssertions,
  type AssertionResult,
  type PlaytestAssertion,
  type ReplayInput,
  type RunMetrics,
  type TracePoint,
} from "./playtest-model.js";

export interface BotSession {
  /** Called on every authoritative tick (the server's tick number). */
  onTick(cb: (tick: number) => void): void;
  onError(cb: (message: string) => void): void;
  onClose(cb: () => void): void;
  sendIntent(i: Extract<ReplayInput, { kind: "intent" }>["intent"]): void;
  chat(channel: "say" | "yell", text: string): void;
  admin(command: string, args?: unknown): Promise<{ ok: boolean; message: string }>;
  /** The bot's own position, once the world has sent it. */
  position(): { x: number; z: number } | null;
}

export interface ExecOptions {
  durationTicks: number;
  inputs: ReplayInput[];
  assertions: PlaytestAssertion[];
  /** Give up after this long without finishing (a stalled server). */
  timeoutMs: number;
}

export interface ExecResult {
  metrics: RunMetrics;
  results: AssertionResult[];
  error?: string;
}

/** p99 in ms from the admin `stats` JSON (a snapshot), or null when it cannot be read. */
export function tickP99FromStats(message: string): number | null {
  try {
    const p99 = (JSON.parse(message) as { tick?: { p99Ms?: unknown } }).tick?.p99Ms;
    return typeof p99 === "number" ? p99 : null;
  } catch {
    return null;
  }
}

export async function execInputs(session: BotSession, opts: ExecOptions): Promise<ExecResult> {
  const queue = [...opts.inputs].sort((a, b) => a.tick - b.tick);
  const errors: string[] = [];
  const adminReplies: RunMetrics["adminReplies"] = [];
  const trace: TracePoint[] = [];
  // The client answers one admin command at a time, so they go out in order.
  let admins: Promise<void> = Promise.resolve();
  let connected = true;
  let startTick: number | null = null;
  let lastRel = -1;
  let error: string | undefined;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      error = `timed out after ${opts.timeoutMs} ms before tick ${opts.durationTicks}`;
      resolve();
    }, opts.timeoutMs);
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    session.onError((m) => errors.push(m));
    session.onClose(() => {
      connected = false;
      error ??= "the connection dropped";
      finish();
    });
    session.onTick((tick) => {
      startTick ??= tick;
      const rel = tick - startTick;
      if (rel === lastRel || rel > opts.durationTicks) return;
      lastRel = rel;
      const pos = session.position();
      if (pos) trace.push({ tick: rel, x: pos.x, z: pos.z });
      while (queue.length > 0 && queue[0].tick <= rel) {
        const inp = queue.shift() as ReplayInput;
        if (inp.kind === "intent") session.sendIntent(inp.intent);
        else if (inp.kind === "chat") session.chat(inp.channel, inp.text);
        else {
          admins = admins.then(async () => {
            const r = await session.admin(inp.command, inp.args).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }));
            adminReplies.push({ step: inp.step, ok: r.ok, expectOk: inp.expectOk, message: r.message });
          });
        }
      }
      if (rel >= opts.durationTicks) finish();
    });
  });
  await admins;

  let tickP99Ms: number | null = null;
  if (connected) {
    try {
      tickP99Ms = tickP99FromStats((await session.admin("stats")).message);
    } catch {
      /* no stats: the tick assertion fails with "no tick data" */
    }
  }
  const metrics: RunMetrics = { ticks: Math.max(0, lastRel), connected, errors, adminReplies, trace, tickP99Ms };
  return { metrics, results: evaluateAssertions(opts.assertions, metrics), ...(error ? { error } : {}) };
}
