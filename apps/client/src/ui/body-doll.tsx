/**
 * Body doll (U12/U9) — the player's own body part by part, from the body
 * message (0x18): each part's state and health as a filled silhouette,
 * open wounds outlined in red, lost parts dashed, and the blood left.
 *
 * The player frame carries a small doll while anything is wrong; the
 * character sheet carries a larger one with the injuries listed, where
 * clicking a part treats it with Medicine (M4).
 */

import { t } from "../i18n.js";
import type { BodyMessage, PartStateName } from "@mmo-engine/protocol";
import { Bar } from "./meter.js";

type Part = BodyMessage["parts"][number];

/** Where each part of the stock body (content/rules/body.json) sits on a 60×110 doll, seen from behind. */
const SHAPES: Record<string, { x: number; y: number; w: number; h: number; r?: number }> = {
  head: { x: 23, y: 2, w: 14, h: 15, r: 7 },
  torso: { x: 19, y: 19, w: 22, h: 28, r: 3 },
  hips: { x: 20, y: 48, w: 20, h: 10, r: 2 },
  armUpperLeft: { x: 10, y: 20, w: 8, h: 18, r: 3 },
  armLowerLeft: { x: 9, y: 39, w: 8, h: 16, r: 3 },
  handLeft: { x: 9, y: 56, w: 8, h: 7, r: 3 },
  armUpperRight: { x: 42, y: 20, w: 8, h: 18, r: 3 },
  armLowerRight: { x: 43, y: 39, w: 8, h: 16, r: 3 },
  handRight: { x: 43, y: 56, w: 8, h: 7, r: 3 },
  legLeft: { x: 20, y: 59, w: 9, h: 48, r: 3 },
  legRight: { x: 31, y: 59, w: 9, h: 48, r: 3 },
};

/** Fill per state; a lost part has none. */
const FILL: Record<PartStateName, string> = {
  healthy: "#94a3b8",
  harmed: "#fbbf24",
  maimed: "#ea580c",
  dismembered: "none",
};

const STATE_TEXT: Record<PartStateName, string> = {
  healthy: "body.state.healthy",
  harmed: "body.state.harmed",
  maimed: "body.state.maimed",
  dismembered: "body.state.dismembered",
};

const STATE_RANK: Record<PartStateName, number> = { healthy: 0, harmed: 1, maimed: 2, dismembered: 3 };

/** A part that needs telling: not whole, bleeding, or below full health. */
export function isInjured(p: Part): boolean {
  return p.state !== "healthy" || p.bleeding || p.hp < 0.995;
}

/** Whether anything about the body is worth showing: an injured part or blood lost. */
export function isHurt(body: BodyMessage | null): boolean {
  if (!body) return false;
  return body.parts.some(isInjured) || body.blood < body.bloodMax - 0.5;
}

/** The injured parts, worst first: lost, maimed, harmed, then bleeding, then by health left. */
export function injuries(body: BodyMessage | null): Part[] {
  if (!body) return [];
  return body.parts
    .filter(isInjured)
    .sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state] || Number(b.bleeding) - Number(a.bleeding) || a.hp - b.hp);
}

/** Whether Medicine has something to do: an injured part, or a lost one's bleeding stump. */
export function treatable(p: Part): boolean {
  return isInjured(p) && (p.state !== "dismembered" || p.bleeding);
}

/** One line for an injured part: "Left leg maimed, bleeding (34%)". */
export function injuryText(p: Part): string {
  const pct = p.state === "dismembered" ? "" : ` (${Math.round(Math.max(0, Math.min(1, p.hp)) * 100)}%)`;
  return t("body.injury", { name: p.name, state: t(STATE_TEXT[p.state]), bleeding: p.bleeding ? t("body.bleeding") : "", pct });
}

export interface BodyDollProps {
  body: BodyMessage;
  /** Height in px; the width follows. */
  size?: number;
  /** Clicking a part (not a lost one) calls this with its id. */
  onPart?: (id: string) => void;
}

export function BodyDoll({ body, size = 110, onPart }: BodyDollProps): React.ReactElement {
  return (
    <svg
      viewBox="0 0 60 110"
      width={(size * 60) / 110}
      height={size}
      role="img"
      aria-label={t("body.label", { injuries: injuries(body).map(injuryText).join("; ") || t("body.unhurt") })}
      className="shrink-0"
    >
      {body.parts.map((p) => {
        const s = SHAPES[p.id];
        if (!s) return null;
        const lost = p.state === "dismembered";
        const clickable = !!onPart && treatable(p);
        return (
          <rect
            key={p.id}
            x={s.x}
            y={s.y}
            width={s.w}
            height={s.h}
            rx={s.r ?? 2}
            fill={FILL[p.state]}
            fillOpacity={lost ? 0 : 0.35 + 0.65 * Math.max(0, Math.min(1, p.hp))}
            stroke={p.bleeding ? "#ef4444" : lost ? "#64748b" : "#0f172a"}
            strokeWidth={p.bleeding ? 1.6 : 0.8}
            strokeDasharray={lost ? "2 1.5" : undefined}
            className={`${p.bleeding ? "animate-pulse" : ""} ${clickable ? "pointer-events-auto cursor-pointer hover:stroke-white" : ""}`}
            onClick={clickable ? () => onPart?.(p.id) : undefined}
          >
            <title>{isInjured(p) ? injuryText(p) : p.name}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** The character sheet's body section: the doll, blood, and the injuries listed (click to treat). */
export function InjuriesSection({ body, onTreat }: { body: BodyMessage | null; onTreat?: (part: string) => void }): React.ReactElement | null {
  if (!body) return null;
  const hurt = injuries(body);
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{t("body.title")}</div>
      <div className="flex gap-3">
        <BodyDoll body={body} size={120} onPart={onTreat} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Bar label={t("body.blood")} value={body.blood} max={body.bloodMax} tone="health" />
          {hurt.length === 0 ? (
            <div className="text-xs text-muted-foreground">{t("body.unhurt")}</div>
          ) : (
            <ul className="flex flex-col gap-0.5 text-xs">
              {hurt.map((p) => (
                <li key={p.id} className="flex items-baseline justify-between gap-1">
                  <span className={p.state === "dismembered" ? "text-muted-foreground line-through" : p.bleeding ? "text-red-400" : ""}>
                    {injuryText(p)}
                  </span>
                  {onTreat && treatable(p) && (
                    <button
                      type="button"
                      className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground hover:bg-secondary"
                      onClick={() => onTreat(p.id)}
                      title={t("body.treat-part", { name: p.name })}
                    >
                      {t("body.treat")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
