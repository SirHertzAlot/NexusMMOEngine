/**
 * CombatHud — First-person & pointer-lock aiming reticle, body-part target
 * indicator, combo timing window cue, hit-marker flash, and persistent
 * Stance (Technique + Aim zone) status bar.
 */

import React from "react";
import { combatMove, Move, type HitMessage, type ItemView } from "@mmo-engine/protocol";
import { t } from "../i18n.js";

export interface CombatReticleTelemetry {
  hoveredEntity: bigint | null;
  hoveredPart: string | null;
  hoveredDistance: number;
  pitchAimPart: string;
  activeMove: number;
  moveElapsed: number;
  pointerLocked: boolean;
}

export interface CombatHudProps {
  view: "third" | "first";
  technique: string | null;
  lockedAim: string | null;
  telemetry: CombatReticleTelemetry;
  mainWeapon?: ItemView | null;
  offWeapon?: ItemView | null;
  lastHit?: { hit: HitMessage; atMs: number } | null;
  nowMs?: number;
}

export interface CombatHudViewModel {
  showReticle: boolean;
  effectiveTechnique: "cut" | "thrust" | "bludgeon";
  effectiveAimPart: string;
  aimMode: "locked" | "reticle" | "pitch";
  inMeleeReach: boolean;
  meleeReachM: number;
  comboStage: 0 | 1 | 2 | 3;
  inChainWindow: boolean;
  isGuarding: boolean;
  isRolling: boolean;
  hitMarker: "hit" | "blocked" | "dodged" | null;
  weaponLabel: string;
  offhandLabel: string | null;
}

const DEFAULT_ARM_REACH_M = 0.65;
const UNARMED_REACH_M = 0.6;
const HIT_MARKER_DURATION_MS = 320;

const BASE_REACH_M: Record<string, number> = {
  sword: 0.9,
  greatsword: 1.4,
  axe: 0.8,
  mace: 0.7,
  dagger: 0.35,
  spear: 2.0,
  staff: 1.6,
  wand: 0.35,
  shield: 0.6,
};

const BASE_TECHNIQUE: Record<string, "cut" | "thrust" | "bludgeon"> = {
  sword: "cut",
  greatsword: "cut",
  axe: "cut",
  mace: "bludgeon",
  dagger: "thrust",
  spear: "thrust",
  staff: "bludgeon",
  wand: "bludgeon",
  shield: "bludgeon",
};

/** Pure helper: derive pitch-implied body part when no explicit aim is locked. */
export function pitchToAimPart(lookPitch: number): string {
  if (!Number.isFinite(lookPitch) || Math.abs(lookPitch) < 0.18) return "torso";
  if (lookPitch <= -0.18) return "head";
  if (lookPitch >= 0.32) return "legLeft";
  return "armUpperLeft";
}

/**
 * Pure DoD/view-model derivation for `CombatHud` so all combat HUD rules
 * (effective technique, aimed body part priority, reach check, combo stage,
 * chain window, and hitmarker state) are deterministically unit-testable.
 */
export function deriveCombatHudModel(props: CombatHudProps): CombatHudViewModel {
  const { view, technique, lockedAim, telemetry, mainWeapon, offWeapon, lastHit } = props;
  const nowMs = props.nowMs ?? (typeof performance !== "undefined" ? performance.now() : 0);

  const showReticle = view === "first" || telemetry.pointerLocked;

  const defaultTech = mainWeapon?.base ? (BASE_TECHNIQUE[mainWeapon.base] ?? "cut") : "bludgeon";
  const effectiveTechnique: "cut" | "thrust" | "bludgeon" =
    technique === "cut" || technique === "thrust" || technique === "bludgeon" ? technique : defaultTech;

  const aimMode: "locked" | "reticle" | "pitch" = lockedAim
    ? "locked"
    : telemetry.hoveredPart
      ? "reticle"
      : "pitch";
  const effectiveAimPart = lockedAim ?? telemetry.hoveredPart ?? telemetry.pitchAimPart ?? "torso";

  const itemReach = mainWeapon?.base ? (BASE_REACH_M[mainWeapon.base] ?? 0.9) : UNARMED_REACH_M;
  const meleeReachM = itemReach + DEFAULT_ARM_REACH_M;
  const inMeleeReach =
    telemetry.hoveredEntity !== null &&
    Number.isFinite(telemetry.hoveredDistance) &&
    telemetry.hoveredDistance <= meleeReachM + 0.35;

  const move = telemetry.activeMove;
  const elapsed = telemetry.moveElapsed;
  const def = combatMove(move);

  const comboStage: 0 | 1 | 2 | 3 =
    move === Move.SwordA || move === Move.SwordARecover
      ? 1
      : move === Move.SwordB || move === Move.SwordBRecover
        ? 2
        : move === Move.SwordC
          ? 3
          : 0;

  const inChainWindow = Boolean(def?.chain && elapsed >= def.chain.from && elapsed <= def.chain.to);
  const isGuarding = move === Move.Guard || move === Move.ShieldBash;
  const isRolling = move === Move.Roll;

  const hitMarker =
    lastHit && nowMs - lastHit.atMs >= 0 && nowMs - lastHit.atMs <= HIT_MARKER_DURATION_MS
      ? lastHit.hit.outcome
      : null;

  const weaponLabel = mainWeapon?.name ?? t("hud.combat.unarmed");
  const offhandLabel = offWeapon?.name ?? null;

  return {
    showReticle,
    effectiveTechnique,
    effectiveAimPart,
    aimMode,
    inMeleeReach,
    meleeReachM,
    comboStage,
    inChainWindow,
    isGuarding,
    isRolling,
    hitMarker,
    weaponLabel,
    offhandLabel,
  };
}

const PART_LABELS: Record<string, string> = {
  head: "HEAD",
  torso: "TORSO",
  armUpperLeft: "L. ARM",
  armUpperRight: "R. ARM",
  legLeft: "L. LEG",
  legRight: "R. LEG",
};

const TECH_LABELS: Record<"cut" | "thrust" | "bludgeon", string> = {
  cut: "CUT",
  thrust: "THRUST",
  bludgeon: "BLUDGEON",
};

function CombatHudImpl(props: CombatHudProps): React.ReactElement {
  const vm = deriveCombatHudModel(props);
  const partLabel = PART_LABELS[vm.effectiveAimPart] ?? vm.effectiveAimPart.toUpperCase();
  const techLabel = TECH_LABELS[vm.effectiveTechnique];

  const reticleColor = vm.inChainWindow
    ? "#fbbf24"
    : vm.inMeleeReach
      ? "#f87171"
      : vm.isGuarding
        ? "#60a5fa"
        : "rgba(241, 245, 249, 0.88)";

  return (
    <div
      data-testid="combat-hud"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 18,
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Center-screen Dynamic Combat Reticle */}
      {vm.showReticle && (
        <div
          data-testid="combat-reticle"
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: 68,
            height: 68,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="68" height="68" viewBox="0 0 68 68" style={{ overflow: "visible" }}>
            {/* Combo chain window gold ring */}
            {vm.inChainWindow && (
              <circle
                cx="34"
                cy="34"
                r="22"
                fill="none"
                stroke="#fbbf24"
                strokeWidth="2.2"
                strokeDasharray="6 4"
              />
            )}

            {/* Guard brace shield arc */}
            {vm.isGuarding && (
              <path
                d="M 16 24 A 22 22 0 0 1 52 24"
                fill="none"
                stroke="#60a5fa"
                strokeWidth="2.8"
                strokeLinecap="round"
              />
            )}

            {/* Technique-specific reticle geometry */}
            {vm.effectiveTechnique === "cut" && (
              <g stroke={reticleColor} strokeWidth="2" strokeLinecap="round">
                <line x1="21" y1="21" x2="28" y2="28" />
                <line x1="47" y1="21" x2="40" y2="28" />
                <line x1="21" y1="47" x2="28" y2="40" />
                <line x1="47" y1="47" x2="40" y2="40" />
              </g>
            )}
            {vm.effectiveTechnique === "thrust" && (
              <g stroke={reticleColor} strokeWidth="1.8" fill="none">
                <polygon points="34,22 46,34 34,46 22,34" />
                <line x1="34" y1="14" x2="34" y2="20" />
                <line x1="34" y1="48" x2="34" y2="54" />
                <line x1="14" y1="34" x2="20" y2="34" />
                <line x1="48" y1="34" x2="54" y2="34" />
              </g>
            )}
            {vm.effectiveTechnique === "bludgeon" && (
              <g stroke={reticleColor} strokeWidth="2.2" fill="none" strokeLinecap="round">
                <path d="M 24 22 L 19 22 L 19 46 L 24 46" />
                <path d="M 44 22 L 49 22 L 49 46 L 44 46" />
                <line x1="34" y1="18" x2="34" y2="25" />
              </g>
            )}

            {/* Center precision dot */}
            <circle cx="34" cy="34" r={vm.inMeleeReach ? 2.8 : 2.0} fill={reticleColor} />

            {/* Hit / Block / Dodge Hit-Marker Flash */}
            {vm.hitMarker && (
              <g
                data-testid="combat-hitmarker"
                stroke={
                  vm.hitMarker === "hit"
                    ? "#ef4444"
                    : vm.hitMarker === "blocked"
                      ? "#38bdf8"
                      : "#cbd5e1"
                }
                strokeWidth="2.6"
                strokeLinecap="round"
              >
                <line x1="15" y1="15" x2="25" y2="25" />
                <line x1="53" y1="15" x2="43" y2="25" />
                <line x1="15" y1="53" x2="25" y2="43" />
                <line x1="53" y1="53" x2="43" y2="43" />
              </g>
            )}
          </svg>

          {/* Reticle Under-Label: Aimed Part + Reach / Combo Cue */}
          <div
            style={{
              position: "absolute",
              top: 56,
              left: "50%",
              transform: "translateX(-50%)",
              whiteSpace: "nowrap",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              textShadow: "0 1px 3px rgba(0,0,0,0.95)",
            }}
          >
            <span
              data-testid="reticle-aim-label"
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.08em",
                color: vm.inMeleeReach ? "#fca5a5" : "rgba(226, 232, 240, 0.85)",
                background: "rgba(15, 23, 42, 0.68)",
                padding: "1px 6px",
                borderRadius: 4,
                border: `1px solid ${vm.inMeleeReach ? "rgba(248, 113, 113, 0.55)" : "rgba(148, 163, 184, 0.25)"}`,
              }}
            >
              {techLabel} · {partLabel}
              {vm.inMeleeReach ? t("hud.combat.inRange") : ""}
            </span>
            {vm.inChainWindow && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 800,
                  color: "#fbbf24",
                  letterSpacing: "0.08em",
                }}
              >
                {t("hud.combat.chainCombo", { stage: vm.comboStage })}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Persistent Compact Combat Stance & Aim Bar (bottom-right above controls) */}
      <div
        data-testid="combat-stance-bar"
        style={{
          position: "absolute",
          right: 18,
          bottom: 76,
          background: "rgba(15, 23, 42, 0.82)",
          border: "1px solid rgba(148, 163, 184, 0.28)",
          borderRadius: 8,
          padding: "8px 12px",
          color: "#e2e8f0",
          display: "flex",
          alignItems: "center",
          gap: 12,
          boxShadow: "0 4px 14px rgba(0, 0, 0, 0.45)",
          backdropFilter: "blur(6px)",
        }}
      >
        {/* Mini 6-Zone Anatomical Target Silhouette */}
        <svg width="34" height="52" viewBox="0 0 34 52" aria-label={t("hud.combat.aimedZone")}>
          {/* Head */}
          <circle
            cx="17"
            cy="8"
            r="5"
            fill={vm.effectiveAimPart === "head" ? "#f87171" : "rgba(148, 163, 184, 0.3)"}
            stroke="#94a3b8"
            strokeWidth="1"
          />
          {/* Torso */}
          <rect
            x="11"
            y="15"
            width="12"
            height="16"
            rx="2"
            fill={vm.effectiveAimPart === "torso" ? "#f87171" : "rgba(148, 163, 184, 0.3)"}
            stroke="#94a3b8"
            strokeWidth="1"
          />
          {/* Left Arm (viewer left = target right arm, viewer right = target left arm) */}
          <rect
            x="4"
            y="16"
            width="5"
            height="14"
            rx="2"
            fill={vm.effectiveAimPart === "armUpperLeft" ? "#f87171" : "rgba(148, 163, 184, 0.3)"}
            stroke="#94a3b8"
            strokeWidth="1"
          />
          {/* Right Arm */}
          <rect
            x="25"
            y="16"
            width="5"
            height="14"
            rx="2"
            fill={vm.effectiveAimPart === "armUpperRight" ? "#f87171" : "rgba(148, 163, 184, 0.3)"}
            stroke="#94a3b8"
            strokeWidth="1"
          />
          {/* Left Leg */}
          <rect
            x="10"
            y="33"
            width="6"
            height="16"
            rx="2"
            fill={vm.effectiveAimPart === "legLeft" ? "#f87171" : "rgba(148, 163, 184, 0.3)"}
            stroke="#94a3b8"
            strokeWidth="1"
          />
          {/* Right Leg */}
          <rect
            x="18"
            y="33"
            width="6"
            height="16"
            rx="2"
            fill={vm.effectiveAimPart === "legRight" ? "#f87171" : "rgba(148, 163, 184, 0.3)"}
            stroke="#94a3b8"
            strokeWidth="1"
          />
        </svg>

        <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12 }}>
          <div style={{ fontWeight: 700, color: "#f8fafc", display: "flex", alignItems: "center", gap: 6 }}>
            <span>{vm.weaponLabel}</span>
            {vm.offhandLabel && (
              <span style={{ fontSize: 11, color: "#94a3b8" }}>+ {vm.offhandLabel}</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 10, fontSize: 11, color: "#cbd5e1" }}>
            <span>
              <strong style={{ color: "#93c5fd" }}>[R]</strong> {t("hud.combat.style")} <strong>{techLabel}</strong>
            </span>
            <span>
              <strong style={{ color: "#93c5fd" }}>[T]</strong> {t("hud.combat.aim")}{" "}
              <strong style={{ color: vm.aimMode === "locked" ? "#fbbf24" : "#f87171" }}>
                {partLabel}
              </strong>{" "}
              <span style={{ color: "#94a3b8", fontSize: 10 }}>
                ({vm.aimMode === "locked" ? t("hud.combat.aimLocked") : vm.aimMode === "reticle" ? t("hud.combat.aimReticle") : t("hud.combat.aimPitch")})
              </span>
            </span>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 10, color: "#94a3b8" }}>
            <span>{t("hud.combat.combo")}</span>
            {[1, 2, 3].map((step) => (
              <span
                key={step}
                style={{
                  width: 16,
                  height: 5,
                  borderRadius: 3,
                  background:
                    vm.comboStage >= step
                      ? vm.inChainWindow
                        ? "#fbbf24"
                        : "#f87171"
                      : "rgba(148, 163, 184, 0.25)",
                }}
              />
            ))}
            <span style={{ marginLeft: 4 }}>
              {props.view === "first" ? t("hud.combat.fpsView") : t("hud.combat.thirdView")}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export const CombatHud = React.memo(CombatHudImpl);
CombatHud.displayName = "CombatHud";
