/**
 * Admin / GM inspection & recovery command handler for the Redwater Crossing
 * civic & escrow slice (wired into Gateway `admin` console as `"civic"`).
 */

import { z } from "zod";
import type { CivicService } from "./civic-service.js";
import type { CivicContractView } from "@mmo-engine/protocol";
import { toContractView } from "./civic-store.js";

export const CivicAdminArgsSchema = z.discriminatedUnion("subcommand", [
  z.strictObject({
    subcommand: z.literal("inspect"),
    target: z.enum(["all", "sites", "veins", "foundries", "contracts", "history"]).default("all"),
    siteId: z.string().optional(),
  }),
  z.strictObject({
    subcommand: z.literal("repair"),
    siteId: z.string().min(1),
  }),
  z.strictObject({
    subcommand: z.literal("stage"),
    siteId: z.string().min(1),
    stage: z.number().int().min(0).max(20),
    damaged: z.boolean().optional(),
  }),
  z.strictObject({
    subcommand: z.literal("set-depletion"),
    townId: z.string().min(1),
    depletedPermille: z.number().int().min(0).max(900),
  }),
  z.strictObject({
    subcommand: z.literal("refund"),
    contractId: z.string().regex(/^\d{1,16}$/),
  }),
  z.strictObject({
    subcommand: z.literal("rotate-vein"),
    veinBatchId: z.string().optional(),
  }),
  z.strictObject({
    subcommand: z.literal("expire-contracts"),
  }),
]);

export type CivicAdminArgs = z.infer<typeof CivicAdminArgsSchema>;

export function runCivicAdminCommand(
  civic: CivicService | undefined,
  rawArgs: unknown,
  actorName: string,
  grantGold: (charId: number, amount: number) => boolean,
  onSiteStateChange?: (siteId: string, stage: number, damaged: boolean) => void,
): { ok: boolean; message: string } {
  if (!civic) return { ok: false, message: "civic module is not active on this server" };
  const parsed = CivicAdminArgsSchema.safeParse(rawArgs ?? { subcommand: "inspect", target: "all" });
  if (!parsed.success) {
    return {
      ok: false,
      message: "usage: { subcommand: 'inspect' | 'repair' | 'stage' | 'refund' | 'rotate-vein' | 'expire-contracts', ... }",
    };
  }
  const cmd = parsed.data;
  const now = Date.now();
  const store = civic.store;
  const rules = civic.getRules();

  switch (cmd.subcommand) {
    case "inspect": {
      const state = civic.buildStateMessage(0);
      const history = store.listHistory(cmd.siteId, 20, 0);
      const allVeins = store.listVeins(true);
      const payload =
        cmd.target === "sites"
          ? { sites: state.sites }
          : cmd.target === "veins"
            ? { veins: allVeins }
            : cmd.target === "foundries"
              ? { foundries: state.foundries }
              : cmd.target === "contracts"
                ? { contracts: state.contracts }
                : cmd.target === "history"
                  ? { history }
                  : { ...state, allVeins, history };
      return { ok: true, message: JSON.stringify(payload) };
    }

    case "repair": {
      const def = rules.sites.find((s) => s.id === cmd.siteId);
      const site = store.getSite(cmd.siteId);
      if (!def || !site) return { ok: false, message: `unknown civic site "${cmd.siteId}"` };
      store.runImmediate(() => {
        store.saveSite({
          ...site,
          damaged: false,
          wear: 0,
          repairProgress: {},
          repairGoldProgress: 0,
          updatedAt: now,
        });
        store.appendHistory({
          siteId: site.id,
          eventType: "admin_override",
          actorId: 0,
          actorName,
          eraTag: site.eraTag,
          detail: `GM ${actorName} repaired ${def.name}`,
          createdAt: now,
        });
      });
      onSiteStateChange?.(site.id, site.stage, false);
      return { ok: true, message: `repaired ${def.name}` };
    }

    case "stage": {
      const def = rules.sites.find((s) => s.id === cmd.siteId);
      const site = store.getSite(cmd.siteId);
      if (!def || !site) return { ok: false, message: `unknown civic site "${cmd.siteId}"` };
      const stageDef = def.stages[cmd.stage];
      if (!stageDef) {
        return { ok: false, message: `stage ${cmd.stage} out of range 0..${def.stages.length - 1}` };
      }
      const nextDamaged = cmd.damaged === true;
      store.runImmediate(() => {
        store.saveSite({
          ...site,
          stage: stageDef.stage,
          progress: {},
          goldProgress: 0,
          repairProgress: {},
          repairGoldProgress: 0,
          wear: nextDamaged ? def.damageThreshold : 0,
          damaged: nextDamaged,
          eraTag: stageDef.label,
          updatedAt: now,
        });
        store.appendHistory({
          siteId: site.id,
          eventType: "admin_override",
          actorId: 0,
          actorName,
          eraTag: stageDef.label,
          detail: `GM ${actorName} set ${def.name} to Stage ${stageDef.stage} (${stageDef.label})${nextDamaged ? " [damaged]" : ""}`,
          createdAt: now,
        });
      });
      onSiteStateChange?.(site.id, stageDef.stage, nextDamaged);
      return { ok: true, message: `set ${def.name} to stage ${stageDef.stage} (${stageDef.label})` };
    }

    case "set-depletion": {
      const fDef = rules.foundries.find((f) => f.id === cmd.townId);
      const foundry = store.getFoundry(cmd.townId);
      if (!fDef || !foundry) return { ok: false, message: `unknown settlement foundry "${cmd.townId}"` };
      const nextDepleted = Math.min(fDef.maxDepletedPermille, Math.max(0, cmd.depletedPermille));
      store.saveFoundry({
        ...foundry,
        depletedPermille: nextDepleted,
        updatedAt: now,
      });
      return {
        ok: true,
        message: JSON.stringify({
          townId: fDef.id,
          depletedPermille: nextDepleted,
          mature: nextDepleted >= fDef.maturityThresholdPermille,
        }),
      };
    }

    case "refund": {
      const id = Number(cmd.contractId);
      let contractView: CivicContractView | null = null;
      let refunded = 0;
      const err = store.runImmediate(() => {
        const row = store.getContract(id);
        if (!row) return `unknown contract #${cmd.contractId}`;
        if (row.status !== "open") return `contract #${cmd.contractId} is already ${row.status}`;
        refunded = row.escrowRemaining;
        const r = store.db
          .prepare(`UPDATE civic_contracts SET status = 'cancelled', escrow_remaining = 0, updated_at = ? WHERE id = ? AND status = 'open'`)
          .run(now, id);
        if (r.changes !== 1) return "contract state changed concurrently";
        contractView = toContractView({ ...row, status: "cancelled", escrowRemaining: 0, updatedAt: now });
        return null;
      });
      if (err || !contractView) return { ok: false, message: err ?? "refund failed" };
      const posterId = (contractView as CivicContractView).posterId;
      if (refunded > 0 && !grantGold(posterId, refunded)) {
        store.addPendingCredits(posterId, refunded, now);
      }
      return {
        ok: true,
        message: JSON.stringify({ contract: contractView, refundedGold: refunded }),
      };
    }

    case "rotate-vein": {
      store.runImmediate(() => {
        const veins = cmd.veinBatchId ? [store.getVein(cmd.veinBatchId)].filter(Boolean) : store.listVeins(false);
        for (const v of veins) {
          if (!v) continue;
          store.upsertVein({ ...v, stock: 0, respawnAt: now });
        }
      });
      civic.ensureActiveVeins(now);
      return { ok: true, message: JSON.stringify({ rotated: true, activeVeins: store.listVeins(false) }) };
    }

    case "expire-contracts": {
      const expired = store.expireDueContracts(now);
      return { ok: true, message: JSON.stringify({ expired }) };
    }
  }
}
