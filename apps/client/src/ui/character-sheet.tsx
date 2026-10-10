/**
 * CharacterSheet (roadmap U9): attributes and derived stats from the
 * stats message (0x0f), with modifier deltas, and skills by family with
 * their peaks (M1), and the body's injuries from the body message (0x18,
 * M2) with a doll whose parts are clicked to treat them (M4), and the
 * disciplines and item familiarity from the skills message (0x1b, M4).
 */

import { useState } from "react";
import type { BodyMessage, SkillLineMessage, SkillsMessage, StatLineMessage } from "@mmo-engine/protocol";
import { InjuriesSection } from "./body-doll.js";
import { DisciplinesSection, FamiliaritySection } from "./disciplines.js";
import { t } from "../i18n.js";

/** Modifier delta text: "+2", "-1", or "" when unmodified. */
export function statDelta(line: StatLineMessage): string {
  const d = Math.round((line.value - line.base) * 100) / 100;
  if (d === 0) return "";
  return d > 0 ? `+${d}` : `${d}`;
}

export function SheetSection({ title, lines }: { title: string; lines: StatLineMessage[] }): React.ReactElement | null {
  if (lines.length === 0) return null;
  return (
    <div>
      <div className="mb-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">{title}</div>
      {lines.map((l) => {
        const delta = statDelta(l);
        return (
          <div key={l.id} className="flex justify-between gap-2 text-sm tabular-nums">
            <span className="text-muted-foreground">{l.name}</span>
            <span className="text-foreground">
              {l.value}
              {delta !== "" && <span className="ml-1 text-xs text-muted-foreground">({delta})</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export interface SkillGroup {
  family: string;
  /** Skills with any value or peak, highest first. */
  trained: SkillLineMessage[];
  untrained: SkillLineMessage[];
}

/** Skills by family, in the order families first appear (the rules' order). */
export function groupSkills(skills: SkillLineMessage[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const k of skills) {
    let g = groups.get(k.family);
    if (!g) groups.set(k.family, (g = { family: k.family, trained: [], untrained: [] }));
    (k.value > 0 || k.peak > 0 ? g.trained : g.untrained).push(k);
  }
  for (const g of groups.values()) g.trained.sort((a, b) => b.value - a.value);
  return [...groups.values()];
}

/** One skill: name, a bar to `max` with the peak marked when it sits above the value, and the value. */
function SkillRow({ skill, max }: { skill: SkillLineMessage; max: number }): React.ReactElement {
  const pct = (v: number): string => `${Math.max(0, Math.min(1, v / max)) * 100}%`;
  const relearn = skill.peak > skill.value;
  return (
    <div className="flex items-center gap-2 text-sm tabular-nums" title={relearn ? t("sheet.peak", { peak: skill.peak }) : undefined}>
      <span className="w-24 shrink-0 truncate text-muted-foreground">{skill.name}</span>
      <div className="relative h-1.5 flex-1 rounded bg-secondary" role="progressbar" aria-label={skill.name} aria-valuenow={skill.value} aria-valuemax={max}>
        <div className="h-full rounded bg-violet-400" style={{ width: pct(skill.value) }} />
        {relearn && <div className="absolute top-[-2px] h-[10px] w-0.5 rounded bg-violet-200/80" style={{ left: pct(skill.peak) }} />}
      </div>
      <span className="w-10 text-right text-foreground">{skill.value.toFixed(1)}</span>
    </div>
  );
}

export function SkillsSection({ skills, max }: { skills: SkillLineMessage[]; max: number }): React.ReactElement | null {
  const [showAll, setShowAll] = useState(false);
  if (skills.length === 0) return null;
  const groups = groupSkills(skills);
  const untrained = groups.reduce((n, g) => n + g.untrained.length, 0);
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between text-[11px] uppercase tracking-wide text-muted-foreground">
        <span>{t("sheet.skills")}</span>
        {untrained > 0 && (
          <button className="normal-case tracking-normal hover:text-foreground" aria-expanded={showAll} onClick={() => setShowAll((s) => !s)}>
            {showAll ? t("sheet.hideUntrained") : t("sheet.showUntrained", { count: untrained })}
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {groups.map((g) => {
          const rows = showAll ? [...g.trained, ...g.untrained] : g.trained;
          if (rows.length === 0) return null;
          return (
            <div key={g.family}>
              <div className="text-[10px] capitalize text-muted-foreground/80">{g.family}</div>
              {rows.map((k) => (
                <SkillRow key={k.id} skill={k} max={max} />
              ))}
            </div>
          );
        })}
        {!showAll && untrained === skills.length && <div className="text-xs text-muted-foreground">{t("sheet.nothingTrained")}</div>}
      </div>
    </div>
  );
}

export function CharacterSheet({
  name,
  attributes,
  stats,
  skills = [],
  skillMax = 100,
  body = null,
  onTreat,
  mastery = null,
}: {
  name: string | null;
  attributes: StatLineMessage[];
  stats: StatLineMessage[];
  skills?: SkillLineMessage[];
  skillMax?: number;
  /** The player's body (0x18) for the injuries section; clicking a part treats it. */
  body?: BodyMessage | null;
  onTreat?: (part: string) => void;
  /** The skills message (0x1b) for disciplines and familiarity. */
  mastery?: SkillsMessage | null;
}): React.ReactElement {
  return (
    <div className="pointer-events-auto max-h-[calc(100vh-8rem)] w-72 overflow-y-auto rounded-lg border bg-card/90 p-3 text-card-foreground shadow-sm">
      {name && <div className="mb-1 truncate text-sm font-semibold">{name}</div>}
      <div className="flex flex-col gap-2">
        <InjuriesSection body={body} onTreat={onTreat} />
        <SheetSection title={t("sheet.attributes")} lines={attributes} />
        <SheetSection title={t("sheet.stats")} lines={stats} />
        <SkillsSection skills={skills} max={skillMax} />
        <DisciplinesSection mastery={mastery} />
        <FamiliaritySection mastery={mastery} />
      </div>
    </div>
  );
}
