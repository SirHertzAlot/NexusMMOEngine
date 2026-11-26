/**
 * CivicPanel — pure mirror view of Redwater Crossing infrastructure, mineral
 * survey bearings, settlement foundries, immutable plaques, and escrow
 * work-order contracts (protocol 0x11 `kind: "civic"`). Zero client-side
 * simulation: every action sends an intent packet to CivicService and renders
 * the authoritative state returned.
 */

import { useState } from "react";
import type {
  CivicClientMessage,
  CivicContractView,
  CivicContributorView,
  CivicFoundryView,
  CivicHistoryEntryView,
  CivicServerMessage,
  CivicSiteView,
  CivicVeinView,
} from "@mmo-engine/protocol";
import { t } from "../i18n.js";

export interface CivicUiState {
  tick: number;
  sites: CivicSiteView[];
  veins: CivicVeinView[];
  foundries: CivicFoundryView[];
  contracts: CivicContractView[];
  pendingCreditsClaimed: number;
  lastSurvey: Extract<CivicServerMessage, { op: "survey_result" }> | null;
  lastNotice: { ok: boolean; code: string; message: string } | null;
  plaque: {
    siteId: string;
    siteName: string;
    stage: number;
    damaged: boolean;
    wear: number;
    eraTag: string;
    totalContributors: number;
    contributors: CivicContributorView[];
    history: CivicHistoryEntryView[];
  } | null;
}

export const INITIAL_CIVIC_UI_STATE: CivicUiState = {
  tick: 0,
  sites: [],
  veins: [],
  foundries: [],
  contracts: [],
  pendingCreditsClaimed: 0,
  lastSurvey: null,
  lastNotice: null,
  plaque: null,
};

/** Pure state reducer for inbound `kind: "civic"` messages from MirrorClient. */
export function nextCivicState(prev: CivicUiState, msg: CivicServerMessage): CivicUiState {
  switch (msg.op) {
    case "state":
      return {
        ...prev,
        tick: msg.tick,
        sites: msg.sites,
        veins: msg.veins,
        foundries: msg.foundries,
        contracts: msg.contracts,
        pendingCreditsClaimed: msg.pendingCreditsClaimed > 0 ? msg.pendingCreditsClaimed : prev.pendingCreditsClaimed,
      };
    case "survey_result":
      return { ...prev, lastSurvey: msg };
    case "extracted": {
      const veins = prev.veins
        .map((v) => (v.veinBatchId === msg.veinBatchId ? { ...v, stock: msg.stockRemaining } : v))
        .filter((v) => v.stock > 0);
      return {
        ...prev,
        veins,
        lastNotice: { ok: true, code: "extracted", message: `+${msg.qty} ${msg.material} (${msg.traitId})` },
      };
    }
    case "contributed": {
      const sites = prev.sites.map((s) =>
        s.siteId === msg.siteId
          ? { ...s, stage: msg.stage, damaged: msg.damaged, wear: msg.wear, eraTag: msg.eraTag }
          : s,
      );
      return {
        ...prev,
        sites,
        lastNotice: {
          ok: true,
          code: msg.stageAdvanced ? "stage_advanced" : msg.repaired ? "repaired" : "contributed",
          message: msg.stageAdvanced
            ? `${msg.siteId} -> ${msg.stage}`
            : msg.repaired
              ? `${msg.siteId} OK`
              : `${msg.siteId}`,
        },
      };
    }
    case "plaque":
      return {
        ...prev,
        plaque: {
          siteId: msg.siteId,
          siteName: msg.siteName,
          stage: msg.stage,
          damaged: msg.damaged,
          wear: msg.wear,
          eraTag: msg.eraTag,
          totalContributors: msg.totalContributors,
          contributors: msg.contributors,
          history: msg.history,
        },
      };
    case "foundry_updated":
      return {
        ...prev,
        foundries: prev.foundries.map((f) => (f.townId === msg.foundry.townId ? msg.foundry : f)),
        ...(msg.escortBonusGold && msg.escortBonusGold > 0
          ? {
              lastNotice: {
                ok: true,
                code: "escort_bonus",
                message: `+${msg.escortBonusGold}g`,
              },
            }
          : {}),
      };
    case "foundry_crafted":
      return {
        ...prev,
        foundries: prev.foundries.map((f) => (f.townId === msg.foundry.townId ? msg.foundry : f)),
        lastNotice: {
          ok: true,
          code: "foundry_crafted",
          message: `${msg.item} (${msg.rank}) · ${msg.provenance.traitId}`,
        },
      };
    case "foundry_reforge":
      return {
        ...prev,
        foundries: prev.foundries.map((f) => (f.townId === msg.foundry.townId ? msg.foundry : f)),
        lastNotice: {
          ok: true,
          code: "foundry_reforge",
          message: `#${msg.itemId} -> ${msg.provenance.traitId} (-${msg.goldCost}g)`,
        },
      };
    case "craft_repair_kit":
      return {
        ...prev,
        foundries: prev.foundries.map((f) => (f.townId === msg.foundry.townId ? msg.foundry : f)),
        lastNotice: {
          ok: true,
          code: "craft_repair_kit",
          message: `+${msg.qty} repair-kit`,
        },
      };
    case "contract_update": {
      const exists = prev.contracts.some((c) => c.contractId === msg.contract.contractId);
      const contracts = exists
        ? prev.contracts.map((c) => (c.contractId === msg.contract.contractId ? msg.contract : c))
        : [msg.contract, ...prev.contracts];
      const bonusSuffix = msg.escortBonusGold && msg.escortBonusGold > 0 ? ` (+${msg.escortBonusGold}g)` : "";
      return {
        ...prev,
        contracts,
        lastNotice: {
          ok: true,
          code: `contract_${msg.action}`,
          message: `#${msg.contract.contractId} ${msg.action}${bonusSuffix}`,
        },
      };
    }
    case "notice":
      return { ...prev, lastNotice: { ok: msg.ok, code: msg.code, message: msg.message } };
  }
}

function nextOpId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
}

export function CivicPanel({
  state,
  onSend,
  onClose,
  reforgeCandidates = [],
}: {
  state: CivicUiState;
  onSend: (msg: CivicClientMessage) => void;
  onClose: () => void;
  reforgeCandidates?: ReadonlyArray<{ id: number; name: string }>;
}): React.ReactElement {
  const [postQty, setPostQty] = useState(10);
  const [postReward, setPostReward] = useState(5);
  const [reforgeItemId, setReforgeItemId] = useState(0);

  const openContracts = state.contracts.filter((c) => c.status === "open");
  const primaryVein = state.veins[0];
  const activeReforgeId =
    reforgeCandidates.length > 0
      ? reforgeCandidates.some((c) => c.id === reforgeItemId)
        ? reforgeItemId
        : reforgeCandidates[0]!.id
      : reforgeItemId;

  return (
    <div className="pointer-events-auto max-h-[calc(100vh-190px)] w-[420px] overflow-y-auto rounded-lg border bg-card/95 p-3 text-card-foreground shadow-md">
      <div className="mb-2 flex items-center justify-between border-b pb-1.5">
        <div className="text-sm font-semibold">{t("civic.title")}</div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="rounded border px-2 py-0.5 text-xs hover:bg-muted"
            onClick={() => onSend({ kind: "civic", op: "state" })}
          >
            {t("civic.refresh")}
          </button>
          <button
            type="button"
            className="rounded border px-1.5 py-0.5 text-xs hover:text-foreground"
            onClick={onClose}
            aria-label={t("civic.close")}
          >
            ×
          </button>
        </div>
      </div>

      {state.lastNotice && (
        <div
          className={`mb-2 rounded border px-2 py-1 text-xs ${
            state.lastNotice.ok ? "border-emerald-500/40 text-emerald-300" : "border-destructive/40 text-destructive"
          }`}
        >
          {state.lastNotice.message}
        </div>
      )}

      {/* Surveying & Veins */}
      <section className="mb-3 rounded border p-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase text-muted-foreground">{t("civic.surveyVeins")}</span>
          <button
            type="button"
            className="rounded border bg-secondary px-2 py-0.5 text-xs hover:opacity-90"
            onClick={() => onSend({ kind: "civic", op: "survey" })}
          >
            {t("civic.surveyBtn")}
          </button>
        </div>
        {state.lastSurvey && (
          <div className="mb-1 text-xs">
            {state.lastSurvey.band === "none"
              ? t("civic.surveyNone")
              : state.lastSurvey.band === "pinpoint"
                ? t("civic.surveyPinpoint", {
                    vein: state.lastSurvey.veinBatchId ?? "",
                    trait: state.lastSurvey.traitName ?? state.lastSurvey.traitId ?? "",
                    stock: state.lastSurvey.stockRemaining ?? 0,
                  })
                : t("civic.surveyBearing", {
                    band: state.lastSurvey.band,
                    direction: state.lastSurvey.direction,
                    dist: state.lastSurvey.distanceBucketM,
                  })}
          </div>
        )}
        {state.veins.map((v) => (
          <div key={v.veinBatchId} className="mt-1 flex items-center justify-between text-xs">
            <span>
              {t("civic.veinLine", { vein: v.veinBatchId, trait: v.traitName, stock: v.stock, max: v.maxStock })}
            </span>
            <button
              type="button"
              className="rounded border px-2 py-0.5 text-[11px] hover:bg-muted"
              onClick={() => onSend({ kind: "civic", op: "extract", veinBatchId: v.veinBatchId, qty: 1 })}
            >
              {t("civic.extract")}
            </button>
          </div>
        ))}
      </section>

      {/* Civic Sites */}
      <section className="mb-3 rounded border p-2">
        <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{t("civic.sites")}</div>
        {state.sites.map((s) => (
          <div key={s.siteId} className="mb-2 border-b border-border/50 pb-2 last:mb-0 last:border-b-0 last:pb-0">
            <div className="flex items-center justify-between text-xs font-medium">
              <span>{t("civic.siteHeading", { name: s.name, stage: s.stage, maxStage: s.maxStage })}</span>
              <span className={s.damaged ? "text-amber-400" : "text-muted-foreground"}>
                {s.damaged ? t("civic.damaged") : t("civic.wear", { wear: s.wear, max: s.wearMax })}
              </span>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {t("civic.siteMeta", { era: s.eraTag, count: s.totalContributors })}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {s.damaged ? (
                <button
                  type="button"
                  className="rounded border border-amber-500/50 px-2 py-0.5 text-[11px] hover:bg-amber-500/10"
                  onClick={() =>
                    onSend({
                      kind: "civic",
                      op: "contribute",
                      siteId: s.siteId,
                      opId: nextOpId("rep"),
                      materials: s.repairRequirements,
                      gold: s.repairGoldCost,
                    })
                  }
                >
                  {t("civic.repairSpan")}
                </button>
              ) : (
                s.stage < s.maxStage && (
                  <button
                    type="button"
                    className="rounded border px-2 py-0.5 text-[11px] hover:bg-muted"
                    onClick={() =>
                      onSend({
                        kind: "civic",
                        op: "contribute",
                        siteId: s.siteId,
                        opId: nextOpId("contrib"),
                        materials: { wood: 5, iron: 5 },
                      })
                    }
                  >
                    {t("civic.supplyMaterials")}
                  </button>
                )
              )}
              <button
                type="button"
                className="rounded border px-2 py-0.5 text-[11px] hover:bg-muted"
                onClick={() => onSend({ kind: "civic", op: "plaque", siteId: s.siteId, offset: 0, limit: 10 })}
              >
                {t("civic.plaque")}
              </button>
            </div>
          </div>
        ))}
      </section>

      {/* Settlement Foundries */}
      <section className="mb-3 rounded border p-2">
        <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{t("civic.foundries")}</div>
        {state.foundries.map((f) => (
          <div key={f.townId} className="mb-2 border-b border-border/50 pb-2 last:mb-0 last:border-b-0 last:pb-0">
            <div className="flex items-center justify-between text-xs font-medium">
              <span>
                {f.name}
                {f.mature && (
                  <span className="ml-1.5 rounded border border-amber-500/40 px-1 py-0.5 text-[10px] text-amber-300">
                    {t("civic.matureBadge")}
                  </span>
                )}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {f.batchesRemaining > 0
                  ? t("civic.foundryBatches", { trait: f.traitName, batches: f.batchesRemaining })
                  : t("civic.baseline")}
              </span>
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {t("civic.foundryMeta", { bonus: f.craftBonusSummary, pct: Math.round(f.depletedPermille / 10) })}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {primaryVein && (
                <button
                  type="button"
                  className="rounded border px-2 py-0.5 text-[11px] hover:bg-muted"
                  onClick={() =>
                    onSend({
                      kind: "civic",
                      op: "foundry_supply",
                      townId: f.townId,
                      opId: nextOpId("fsup"),
                      veinBatchId: primaryVein.veinBatchId,
                      material: "iron",
                      qty: 5,
                    })
                  }
                >
                  {t("civic.supplyOre")}
                </button>
              )}
              <button
                type="button"
                className="rounded border px-2 py-0.5 text-[11px] hover:bg-muted"
                onClick={() =>
                  onSend({
                    kind: "civic",
                    op: "foundry_craft",
                    townId: f.townId,
                    opId: nextOpId("fcraft"),
                    item: "sword",
                    rank: "common",
                  })
                }
              >
                {t("civic.forgeSword")}
              </button>
              {f.mature && (
                <>
                  <button
                    type="button"
                    className="rounded border border-emerald-500/40 px-2 py-0.5 text-[11px] hover:bg-emerald-500/10"
                    onClick={() =>
                      onSend({
                        kind: "civic",
                        op: "craft_repair_kit",
                        townId: f.townId,
                        opId: nextOpId("rkit"),
                      })
                    }
                  >
                    {t("civic.craftRepairKit")}
                  </button>
                  {reforgeCandidates.length > 0 ? (
                    <select
                      value={activeReforgeId}
                      onChange={(e) => setReforgeItemId(Number(e.target.value) || 0)}
                      className="max-w-[140px] rounded border bg-background px-1 py-0.5 text-[11px]"
                      aria-label={t("civic.reforgeItemLabel")}
                    >
                      {reforgeCandidates.map((cand) => (
                        <option key={cand.id} value={cand.id}>
                          {cand.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="number"
                      min={1}
                      value={activeReforgeId > 0 ? activeReforgeId : ""}
                      onChange={(e) => setReforgeItemId(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                      className="w-14 rounded border bg-background px-1 py-0.5 text-[11px] tabular-nums"
                      aria-label={t("civic.reforgeItemLabel")}
                    />
                  )}
                  <button
                    type="button"
                    disabled={activeReforgeId <= 0}
                    className="rounded border border-amber-500/50 px-2 py-0.5 text-[11px] hover:bg-amber-500/10 disabled:opacity-50"
                    onClick={() => {
                      if (activeReforgeId > 0) {
                        onSend({
                          kind: "civic",
                          op: "foundry_reforge",
                          townId: f.townId,
                          opId: nextOpId("reforge"),
                          itemId: activeReforgeId,
                        });
                      }
                    }}
                  >
                    {t("civic.reforgeItem", { gold: f.reforgeGoldCost ?? 25 })}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </section>

      {/* Escrow Work Orders */}
      <section className="mb-2 rounded border p-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase text-muted-foreground">{t("civic.contracts")}</span>
          <div className="flex items-center gap-1 text-[11px]">
            <input
              type="number"
              min={1}
              max={500}
              value={postQty}
              onChange={(e) => setPostQty(Math.max(1, Number(e.target.value) || 1))}
              className="w-12 rounded border bg-background px-1 py-0.5 text-xs tabular-nums"
              aria-label={t("civic.contractQtyLabel")}
            />
            <span>@</span>
            <input
              type="number"
              min={1}
              max={10000}
              value={postReward}
              onChange={(e) => setPostReward(Math.max(1, Number(e.target.value) || 1))}
              className="w-12 rounded border bg-background px-1 py-0.5 text-xs tabular-nums"
              aria-label={t("civic.contractRewardLabel")}
            />
            <button
              type="button"
              className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted"
              onClick={() =>
                onSend({
                  kind: "civic",
                  op: "contract_post",
                  opId: nextOpId("cpost"),
                  targetKind: "site",
                  targetId: state.sites[0]?.siteId ?? "redwater-bridge",
                  material: "iron",
                  qty: postQty,
                  rewardPerUnit: postReward,
                })
              }
            >
              {t("civic.post")}
            </button>
          </div>
        </div>
        {openContracts.length === 0 ? (
          <div className="text-[11px] text-muted-foreground">{t("civic.noContracts")}</div>
        ) : (
          <div className="space-y-1">
            {openContracts.map((c) => (
              <div key={c.contractId} className="flex items-center justify-between text-xs">
                <span>
                  {t("civic.contractLine", {
                    id: c.contractId,
                    material: c.material,
                    delivered: c.deliveredQty,
                    total: c.totalQty,
                    reward: c.rewardPerUnit,
                    target: c.targetId,
                  })}
                </span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    className="rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted"
                    onClick={() =>
                      onSend({
                        kind: "civic",
                        op: "contract_deliver",
                        opId: nextOpId("cdel"),
                        contractId: c.contractId,
                        qty: c.totalQty - c.deliveredQty,
                      })
                    }
                  >
                    {t("civic.deliver")}
                  </button>
                  <button
                    type="button"
                    className="rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted"
                    onClick={() =>
                      onSend({
                        kind: "civic",
                        op: "contract_cancel",
                        opId: nextOpId("ccanc"),
                        contractId: c.contractId,
                      })
                    }
                  >
                    {t("civic.cancel")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {state.plaque && (
        <section className="mt-2 rounded border p-2 text-xs">
          <div className="mb-1 font-semibold">
            {t("civic.plaqueHeader", {
              name: state.plaque.siteName,
              shown: state.plaque.contributors.length,
              total: state.plaque.totalContributors,
            })}
          </div>
          <ul className="space-y-0.5 text-[11px] text-muted-foreground">
            {state.plaque.history.map((h) => (
              <li key={h.seq}>{`${h.actorName}: ${h.detail}`}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
