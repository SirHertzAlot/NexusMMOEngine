/**
 * Quests (roadmap U11, P1 on the server): the quest log, the on-screen
 * tracker, and the npc dialog window.
 *
 * Everything here reads the server's messages as they come (the whole log
 * on every change, the npc's line with the replies open to the player) and
 * sends ops back through callbacks; nothing about quests is decided here.
 */

import { t } from "../i18n.js";
import { useEffect, useState } from "react";
import type { DialogMessage, QuestStepView, QuestView } from "@mmo-engine/protocol";
import { Button } from "./components.js";

/** An open dialog (not the closed notice). */
export type OpenDialog = Extract<DialogMessage, { text: string }>;

const STATE_ORDER: Record<QuestView["state"], number> = { ready: 0, active: 1, done: 2 };

/** Ready to hand in first, then in progress, then done; the server's order within each. */
export function sortQuests(quests: readonly QuestView[]): QuestView[] {
  return quests
    .map((q, i) => ({ q, i }))
    .sort((a, b) => STATE_ORDER[a.q.state] - STATE_ORDER[b.q.state] || a.i - b.i)
    .map((x) => x.q);
}

/** The step being worked on: the last one shown that isn't done (null when every shown step is). */
export function currentStep(q: QuestView): QuestStepView | null {
  for (let i = q.steps.length - 1; i >= 0; i--) if (!q.steps[i].done) return q.steps[i];
  return null;
}

/** "1/3" for counted steps (kills, items); "" for talk and reach. */
export function stepProgress(s: QuestStepView): string {
  return s.target > 1 ? `${Math.min(s.progress, s.target)}/${s.target}` : "";
}

/** A step's text, without a trailing "(3)" when the count shows beside it. */
export function stepText(s: QuestStepView): string {
  return s.target > 1 ? s.text.replace(/\s*\(\d+\)(\.?)$/, "$1") : s.text;
}

/** "iron-sword" -> "Iron sword". */
export function itemTitle(base: string): string {
  const t = base.replace(/[-_]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * What changed between two quest logs, as notices: accepted, a step done
 * or counted on, ready to hand in, complete, abandoned. The first log on
 * entering the world (prev null) says nothing.
 */
export function questNotices(prev: readonly QuestView[] | null, next: readonly QuestView[]): string[] {
  if (!prev) return [];
  const out: string[] = [];
  const before = new Map(prev.map((q) => [q.id, q]));
  for (const q of next) {
    const p = before.get(q.id);
    before.delete(q.id);
    if (!p || (p.state === "done" && q.state !== "done")) {
      if (q.state !== "done") out.push(t("quest.accepted", { name: q.name }));
      continue;
    }
    if (q.state === "done" && p.state !== "done") out.push(t("quest.complete", { name: q.name }));
    else if (q.state === "ready" && p.state !== "ready") out.push(t("quest.return-to", { name: q.name, giver: q.giver }));
    else if (q.state === "active") {
      const step = currentStep(q);
      const was = currentStep(p);
      if (q.steps.filter((s) => s.done).length > p.steps.filter((s) => s.done).length && step) out.push(`${q.name}: ${step.text}`);
      else if (step && was && step.text === was.text && step.progress > was.progress && step.target > 1) out.push(`${stepText(step).replace(/\.$/, "")} ${stepProgress(step)}`);
    }
  }
  for (const p of before.values()) if (p.state !== "done") out.push(t("quest.abandoned", { name: p.name }));
  return out;
}

function StepLine({ step }: { step: QuestStepView }): React.ReactElement {
  return (
    <li className={`flex items-baseline gap-1.5 ${step.done ? "text-muted-foreground line-through" : ""}`}>
      <span aria-hidden className="w-3 shrink-0 text-center">
        {step.done ? "✓" : "○"}
      </span>
      <span className="flex-1">{stepText(step)}</span>
      {stepProgress(step) && <span className="tabular-nums">{stepProgress(step)}</span>}
    </li>
  );
}

const STATE_BADGE: Record<QuestView["state"], { text: string; tone: string }> = {
  ready: { text: "quest.badge.ready", tone: "border-yellow-400/60 text-yellow-300" },
  active: { text: "quest.badge.active", tone: "border-sky-400/50 text-sky-300" },
  done: { text: "quest.badge.done", tone: "border-border text-muted-foreground" },
};

/** The quest log panel: every quest, its steps so far, rewards, and abandon. */
export function QuestLog({ quests, onAbandon }: { quests: readonly QuestView[]; onAbandon: (id: string) => void }): React.ReactElement {
  const [openId, setOpenId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const sorted = sortQuests(quests);
  const done = sorted.filter((q) => q.state === "done");
  const shown = showDone ? sorted : sorted.filter((q) => q.state !== "done");
  return (
    <div className="pointer-events-auto max-h-[calc(100vh-8rem)] w-80 overflow-y-auto rounded-lg border bg-card/90 p-3 text-card-foreground shadow-sm">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-sm font-semibold">{t("quest.title")}</div>
        {done.length > 0 && (
          <button type="button" className="text-[11px] text-muted-foreground hover:underline" onClick={() => setShowDone((v) => !v)}>
            {showDone ? t("quest.hide-done") : t("quest.show-done", { n: done.length })}
          </button>
        )}
      </div>
      {shown.length === 0 && <div className="text-xs text-muted-foreground">{t("quest.none")}</div>}
      <ul className="flex flex-col gap-2">
        {shown.map((q) => {
          const open = openId === q.id || (openId === null && q === shown[0]);
          const badge = STATE_BADGE[q.state];
          return (
            <li key={q.id} className="rounded-md border bg-background/40 p-2">
              <button type="button" className="flex w-full items-baseline justify-between gap-2 text-left" onClick={() => setOpenId(open ? "" : q.id)} aria-expanded={open}>
                <span className={`text-sm font-medium ${q.state === "ready" ? "text-yellow-300" : ""}`}>{q.name}</span>
                <span className={`shrink-0 rounded border px-1 text-[10px] ${badge.tone}`}>{t(badge.text)}</span>
              </button>
              {open && (
                <div className="mt-1.5 flex flex-col gap-1.5 text-xs">
                  <div className="text-muted-foreground">
                    {q.summary} <span className="whitespace-nowrap">({q.giver})</span>
                  </div>
                  <ul className="flex flex-col gap-0.5">
                    {q.steps.map((s, i) => (
                      <StepLine key={i} step={s} />
                    ))}
                    {q.state === "ready" && <li className="text-yellow-300">{t("quest.return", { giver: q.giver })}</li>}
                  </ul>
                  {q.rewards.length > 0 && (
                    <div className="text-muted-foreground">
                      {t("quest.reward", { items: q.rewards.map((r) => (r.count > 1 ? t("quest.reward-count", { item: itemTitle(r.base), n: r.count }) : itemTitle(r.base))).join(", ") })}
                    </div>
                  )}
                  {q.state === "active" && (
                    <div className="flex justify-end">
                      <button type="button" className="rounded border px-1.5 text-[10px] text-muted-foreground hover:bg-secondary" onClick={() => onAbandon(q.id)}>
                        {t("quest.abandon")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The on-screen tracker: up to three quests under way and the step each is on. */
export function QuestTracker({ quests }: { quests: readonly QuestView[] }): React.ReactElement | null {
  const live = sortQuests(quests)
    .filter((q) => q.state !== "done")
    .slice(0, 3);
  if (live.length === 0) return null;
  return (
    <div className="pointer-events-none rounded-lg bg-card/60 p-2 text-card-foreground shadow-sm" aria-label={t("quest.tracker")}>
      <ul className="flex flex-col gap-1.5">
        {live.map((q) => {
          const s = currentStep(q);
          return (
            <li key={q.id} className="text-xs">
              <div className={`font-semibold ${q.state === "ready" ? "text-yellow-300" : ""}`}>{q.name}</div>
              <div className="flex justify-between gap-2 text-muted-foreground">
                <span>{q.state === "ready" ? t("quest.return", { giver: q.giver }) : s ? stepText(s) : ""}</span>
                {s && q.state !== "ready" && stepProgress(s) && <span className="tabular-nums">{stepProgress(s)}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The npc dialog: their line and the replies open to the player. Number
 * keys pick a reply, Escape closes; both are kept from the game's keys.
 */
export function DialogPanel({ dialog, onReply, onClose }: { dialog: OpenDialog; onReply: (index: number) => void; onClose: () => void }): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      const n = /^Digit([1-9])$/.exec(e.code);
      if (n) {
        const r = dialog.replies[Number(n[1]) - 1];
        if (r) {
          e.preventDefault();
          e.stopPropagation();
          onReply(r.index);
        }
      } else if (e.code === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dialog, onReply, onClose]);
  return (
    <div className="pointer-events-auto w-[26rem] max-w-[calc(100vw-2rem)] rounded-lg border bg-card/95 p-4 text-card-foreground shadow-lg" role="dialog" aria-label={dialog.name}>
      <div className="mb-1 flex items-baseline justify-between">
        <div className="text-sm font-semibold text-amber-200">{dialog.name}</div>
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={onClose} aria-label={t("quest.close-dialog")}>
          ✕
        </button>
      </div>
      <p className="mb-3 text-sm leading-relaxed">{dialog.text}</p>
      <ol className="flex flex-col gap-1">
        {dialog.replies.map((r, i) => (
          <li key={r.index}>
            <Button variant="secondary" size="sm" className="!h-auto w-full !justify-start !whitespace-normal !py-1.5 text-left" onClick={() => onReply(r.index)}>
              <span className="mr-2 text-muted-foreground">{i + 1}.</span>
              {r.text}
            </Button>
          </li>
        ))}
      </ol>
    </div>
  );
}
