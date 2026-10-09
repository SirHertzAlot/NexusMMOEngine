/**
 * Disciplines and familiarity (roadmap M4) on the character sheet, from
 * the skills message (0x1b): the disciplines earned, whether their
 * techniques can be used now (and which skill has slipped when not), the
 * ones still to earn with how far along each skill is, and how familiar
 * the player is with each item family.
 */

import { t } from "../i18n.js";
import { useState } from "react";
import type { DisciplineRequirement, SkillsMessage } from "@mmo-engine/protocol";

type SkillLine = SkillsMessage["skills"][number];

/** One requirement against the player's skills now. */
export interface RequirementLine {
  skill: string;
  name: string;
  level: number;
  value: number;
  /** At the level now. */
  met: boolean;
}

/** "throwDown" -> "Throw down", "sweep" -> "Sweep". */
export function techniqueTitle(id: string): string {
  const t = id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .toLowerCase()
    .trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Each requirement with the skill's name and value now (unknown skills count as 0). */
export function requirementLines(requires: readonly DisciplineRequirement[], skills: readonly SkillLine[]): RequirementLine[] {
  const byId = new Map(skills.map((k) => [k.id, k]));
  return requires.map((r) => {
    const k = byId.get(r.skill);
    const value = k?.value ?? 0;
    return { skill: r.skill, name: k?.name ?? techniqueTitle(r.skill), level: r.level, value, met: value >= r.level };
  });
}

/** How far along a discipline is, 0..1: each skill's share of its level, averaged. */
export function disciplineProgress(lines: readonly RequirementLine[]): number {
  if (lines.length === 0) return 1;
  return lines.reduce((sum, l) => sum + Math.min(1, l.level > 0 ? l.value / l.level : 1), 0) / lines.length;
}

/** "Cutting below 80, Parrying below 70": why an earned discipline's techniques are out of reach. */
export function lapsedText(lines: readonly RequirementLine[]): string {
  return lines
    .filter((l) => !l.met)
    .map((l) => t("disciplines.below", { name: l.name, level: l.level }))
    .join(", ");
}

/** Disciplines still to earn, closest first (rules order on ties). */
export function goalsByProgress(m: SkillsMessage): { id: string; name: string; unlocks: string[]; lines: RequirementLine[]; progress: number }[] {
  return (m.toward ?? [])
    .map((d, i) => {
      const lines = requirementLines(d.requires, m.skills);
      return { id: d.id, name: d.name, unlocks: d.unlocks, lines, progress: disciplineProgress(lines), i };
    })
    .sort((a, b) => b.progress - a.progress || a.i - b.i)
    .map(({ i: _i, ...g }) => g);
}

function Unlocks({ unlocks, dim }: { unlocks: readonly string[]; dim?: boolean }): React.ReactElement | null {
  if (unlocks.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {unlocks.map((u) => (
        <span key={u} className={`rounded border px-1 text-[10px] ${dim ? "border-border text-muted-foreground" : "border-amber-400/50 text-amber-200"}`}>
          {techniqueTitle(u)}
        </span>
      ))}
    </span>
  );
}

const pct = (v: number): string => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;

/** Earned disciplines, then the ones to work toward with each skill's progress. */
export function DisciplinesSection({ mastery }: { mastery: SkillsMessage | null }): React.ReactElement | null {
  const [showAll, setShowAll] = useState(false);
  if (!mastery || (mastery.disciplines.length === 0 && (mastery.toward ?? []).length === 0)) return null;
  const goals = goalsByProgress(mastery);
  const shownGoals = showAll ? goals : goals.slice(0, 2);
  return (
    <div aria-label={t("disciplines.title")}>
      <div className="mb-0.5 flex items-center justify-between text-[11px] uppercase tracking-wide text-muted-foreground">
        <span>{t("disciplines.title")}</span>
        {goals.length > 2 && (
          <button className="normal-case tracking-normal hover:text-foreground" aria-expanded={showAll} onClick={() => setShowAll((s) => !s)}>
            {showAll ? t("disciplines.fewer") : t("disciplines.more", { n: goals.length - 2 })}
          </button>
        )}
      </div>
      <ul className="flex flex-col gap-1.5">
        {mastery.disciplines.map((d) => {
          const lapsed = !d.active && d.requires ? lapsedText(requirementLines(d.requires, mastery.skills)) : "";
          return (
            <li key={d.id} className="rounded-md border border-amber-400/30 bg-amber-400/5 p-1.5 text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold text-amber-200">{d.name}</span>
                <span className={`text-[10px] ${d.active ? "text-emerald-300" : "text-orange-300"}`}>{d.active ? t("disciplines.active") : t("disciplines.lapsed")}</span>
              </div>
              <div className="mt-1">
                <Unlocks unlocks={d.unlocks} dim={!d.active} />
              </div>
              {!d.active && <div className="mt-0.5 text-[11px] text-muted-foreground">{lapsed ? t("disciplines.train-back", { lapsed }) : t("disciplines.train-back-generic")}</div>}
            </li>
          );
        })}
        {shownGoals.map((g) => (
          <li key={g.id} className="rounded-md border bg-background/40 p-1.5 text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{g.name}</span>
              <span className="tabular-nums text-muted-foreground">{pct(g.progress)}</span>
            </div>
            <div className="mt-1 h-1 rounded bg-secondary" role="progressbar" aria-label={g.name} aria-valuenow={Math.round(g.progress * 100)} aria-valuemax={100}>
              <div className="h-full rounded bg-amber-300/70" style={{ width: pct(g.progress) }} />
            </div>
            <ul className="mt-1 flex flex-col">
              {g.lines.map((l) => (
                <li key={l.skill} className={`flex justify-between tabular-nums ${l.met ? "text-emerald-300/90" : "text-muted-foreground"}`}>
                  <span>
                    {l.met ? "✓ " : ""}
                    {l.name}
                  </span>
                  <span>
                    {l.value.toFixed(1)} / {l.level}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
              {t("disciplines.unlocks")} <Unlocks unlocks={g.unlocks} dim />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Item families the player has used, most familiar first. */
export function FamiliaritySection({ mastery }: { mastery: SkillsMessage | null }): React.ReactElement | null {
  const fam = (mastery?.familiarity ?? []).filter((f) => f.value > 0).sort((a, b) => b.value - a.value);
  if (fam.length === 0) return null;
  return (
    <div aria-label={t("disciplines.familiarity")}>
      <div className="mb-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">{t("disciplines.familiarity")}</div>
      <div className="flex flex-col gap-1">
        {fam.map((f) => (
          <div key={f.family} className="flex items-center gap-2 text-sm tabular-nums">
            <span className="w-24 shrink-0 truncate capitalize text-muted-foreground">{techniqueTitle(f.family)}</span>
            <div className="h-1.5 flex-1 rounded bg-secondary" role="progressbar" aria-label={f.family} aria-valuenow={Math.round(f.value * 100)} aria-valuemax={100}>
              <div className="h-full rounded bg-sky-400" style={{ width: pct(f.value) }} />
            </div>
            <span className="w-10 text-right text-foreground">{pct(f.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
