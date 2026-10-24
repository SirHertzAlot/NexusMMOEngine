/**
 * Dungeon runs (roadmap D4) for the player: the run's HUD while inside
 * (name, time left, creatures and boss left) and the result card when it
 * ends, with the way back to the open world.
 *
 * The instance sends its state on entering and every 5 s; between those
 * the clock counts down locally from the last one.
 */

import { useEffect, useState } from "react";
import type { DungeonMessage } from "@mmo-engine/protocol";
import { Button } from "./components.js";
import { t } from "../i18n.js";

export type DungeonState = Extract<DungeonMessage, { op: "state" }>;
export type DungeonEnded = Extract<DungeonMessage, { op: "ended" }>;

/**
 * Where the player is with a run: being moved in, playing it (with the
 * last state and when it came), or done with its result, being moved out.
 */
export type DungeonRun =
  | { phase: "entering"; dungeon: string }
  | { phase: "in"; dungeon: string; state: DungeonState | null; at: number }
  | { phase: "ended"; dungeon: string; result: DungeonEnded }
  | { phase: "leaving"; dungeon: string };

/** "12:05" for 725 s; hours roll into minutes ("75:00"). */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Seconds left now, counting down from the last state received `at` (ms). */
export function secondsLeft(state: DungeonState, at: number, now: number): number {
  return Math.max(0, state.secondsLeft - (now - at) / 1000);
}

/** Ids of the run's chests still closed. */
export function unopenedChests(state: DungeonState | null): string[] {
  if (!state) return [];
  return state.chests.filter((c) => !c.opened).map((c) => c.id);
}

const OUTCOME_TONE: Record<DungeonEnded["outcome"], string> = {
  cleared: "text-yellow-300",
  timeout: "text-orange-300",
  abandoned: "text-muted-foreground",
};

/** The result card's title, line and loot text. */
export function outcomeText(r: DungeonEnded): { title: string; tone: string; line: string; loot: string } {
  const loot = r.items === 0 ? t("dungeon.noLoot") : t("dungeon.loot", { count: r.items });
  return { title: t(`dungeon.${r.outcome}.title`), tone: OUTCOME_TONE[r.outcome], line: t(`dungeon.${r.outcome}.line`), loot };
}

/** Top-centre while inside: the dungeon's name, the clock, what's left to kill, and and the chests left (E opens one in reach). */
export function DungeonHud({ run }: { run: Extract<DungeonRun, { phase: "in" }> }): React.ReactElement {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const s = run.state;
  const left = s ? secondsLeft(s, run.at, now) : null;
  const closed = unopenedChests(s);
  return (
    <div className="pointer-events-none rounded-lg border border-violet-400/30 bg-card/85 px-4 py-2 text-center text-card-foreground shadow-sm" aria-label={t("dungeon.title")}>
      <div className="text-sm font-semibold text-violet-200">{run.dungeon}</div>
      {s && (
        <div className="mt-0.5 flex items-center justify-center gap-3 text-xs text-muted-foreground">
          <span className={`tabular-nums ${left !== null && left < 300 ? "text-orange-300" : ""}`}>⏳ {formatClock(left ?? 0)}</span>
          <span>{t("dungeon.left", { count: s.creaturesLeft })}</span>
          <span className={s.bossLeft > 0 ? "text-red-300" : "text-yellow-300"}>{s.bossLeft > 0 ? t("dungeon.bossAwaits") : t("dungeon.bossSlain")}</span>
        </div>
      )}
      {closed.length > 0 && <div className="mt-1 text-xs text-amber-200">🎁 {t("dungeon.chestsLeft", { count: closed.length })}</div>}
    </div>
  );
}

/** The run is over: how it went, the loot, and back to the world. */
export function DungeonResult({ run, onLeave }: { run: Extract<DungeonRun, { phase: "ended" }>; onLeave: () => void }): React.ReactElement {
  const result = outcomeText(run.result);
  return (
    <div className="pointer-events-auto w-80 rounded-lg border bg-card/95 p-4 text-center text-card-foreground shadow-lg" role="dialog" aria-label={t("dungeon.result")}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{run.dungeon}</div>
      <div className={`mt-1 text-lg font-semibold ${result.tone}`}>{result.title}</div>
      <div className="mt-1 text-sm">{result.line}</div>
      <div className="mt-2 text-sm text-muted-foreground">{result.loot}</div>
      <Button className="mt-3 w-full" onClick={onLeave}>
        {t("dungeon.return")}
      </Button>
    </div>
  );
}

/** Full-screen while moving between the world and a run. */
export function DungeonTransit({ run }: { run: Extract<DungeonRun, { phase: "entering" | "leaving" }> }): React.ReactElement {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/70">
      <div className="text-center">
        <div className="text-xs uppercase tracking-widest text-violet-300/80">{run.phase === "entering" ? t("dungeon.entering") : t("dungeon.leaving")}</div>
        <div className="mt-1 text-2xl font-semibold text-violet-100">{run.dungeon}</div>
      </div>
    </div>
  );
}
