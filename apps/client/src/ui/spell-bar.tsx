import { memo } from "react";
import type { SpellBarEntry } from "../render/vfx/spell-content.js";
import { t } from "../i18n.js";

export interface SpellBarProps {
  spells: readonly SpellBarEntry[];
  armedSpellId: string | null;
  manaCurrent: number | null;
  onActivate: (spell: SpellBarEntry) => void;
  onCancelArm: () => void;
}

function SpellBarImpl({
  spells,
  armedSpellId,
  manaCurrent,
  onActivate,
  onCancelArm,
}: SpellBarProps): React.ReactElement | null {
  if (spells.length === 0) return null;
  const armed = armedSpellId ? spells.find((s) => s.id === armedSpellId) : null;

  return (
    <div className="pointer-events-none flex flex-col items-center gap-1.5">
      {armed ? (
        <div
          className="pointer-events-auto flex items-center gap-2 rounded-md border px-3 py-1 text-xs font-medium shadow-md backdrop-blur-sm bg-card/90"
          style={{ borderColor: armed.elementColor }}
        >
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: armed.elementColor }}
          />
          <span>{t("spell.splinePrompt", { name: armed.name })}</span>
          <button
            type="button"
            className="ml-1 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
            onClick={onCancelArm}
          >
            {t("spell.cancelHint")}
          </button>
        </div>
      ) : null}
      <div
        className="pointer-events-auto flex items-center justify-center gap-1 rounded-lg border bg-card/90 p-1.5 text-card-foreground shadow-sm"
        role="toolbar"
        aria-label={t("spell.barTitle")}
      >
        {spells.map((sp, idx) => {
          const isArmed = sp.id === armedSpellId;
          const lowMana = manaCurrent !== null && manaCurrent < sp.manaCost;
          return (
            <button
              key={sp.id}
              type="button"
              disabled={lowMana}
              title={t(sp.target === "spline" ? "spell.tooltipSpline" : "spell.tooltipCast", { name: sp.name })}
              aria-pressed={isArmed}
              onClick={() => onActivate(sp)}
              className={[
                "relative flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium transition-colors",
                isArmed ? "ring-2 ring-amber-400 bg-primary/20" : "hover:bg-accent/50",
                lowMana ? "opacity-45 cursor-not-allowed" : "cursor-pointer",
              ].join(" ")}
              style={{
                borderColor: isArmed ? sp.elementColor : undefined,
              }}
            >
              <span
                className="inline-block h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: sp.elementColor }}
              />
              <span>{sp.name}</span>
              <span className="text-[10px] text-muted-foreground">{idx + 1}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export const SpellBar = memo(SpellBarImpl);
SpellBar.displayName = "SpellBar";
