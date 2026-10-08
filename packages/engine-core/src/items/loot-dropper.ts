/**
 * LootDropper (roadmap L2): when a creature dies it rolls its drop rules and
 * leaves mob-pool items on the ground where it fell, owned by the killer's
 * character for the loot rules' ownership time (D2), then free for anyone.
 * Seeded and deterministic; wired as DeathSystem's `onDeath`.
 */

import { hasComponent } from "bitecs";
import type { CreaturesRules } from "@mmo-engine/rules";
import * as C from "../components.js";
import { hash } from "../procgen/ecology.js";
import type { SimWorld } from "../world.js";
import type { LifeEvent } from "../death.js";
import type { ItemDefs } from "./item-defs.js";
import type { ItemService } from "./item-service.js";
import type { WalletSystem } from "../economy/wallet.js";

export interface LootDropperOptions {
  items: ItemService;
  defs: ItemDefs;
  creatures: CreaturesRules["creatures"];
  /** Creature kind id of an entity, undefined if it is not a creature. */
  kindOf: (e: number) => string | undefined;
  seed?: number;
  /** Gold drops go here; absent: gold is not granted. */
  wallet?: WalletSystem;
}

/** Drops scatter this far from the body, metres. */
const SCATTER = 1.2;

export class LootDropper {
  private state: number;
  private readonly pool: readonly number[];

  private creatures: CreaturesRules["creatures"];

  constructor(private readonly opts: LootDropperOptions) {
    this.creatures = opts.creatures;
    this.state = opts.seed ?? 20261003;
    this.pool = opts.defs.ofSource("mob");
  }

  private rand(): number {
    this.state = hash(this.state, 0x27d4eb2f);
    return this.state / 4294967296;
  }

  /** Roll the drops for a death event; returns how many items landed. */
  onDeath(sim: SimWorld, ev: LifeEvent): number {
    if (ev.state !== "dead") return 0;
    const kind = this.opts.kindOf(ev.target);
    const rules = kind === undefined ? undefined : this.creatures[kind]?.drops;
    if (!rules) return 0;
    const owner = ev.killer !== undefined && hasComponent(sim.ecs, C.CharacterRef, ev.killer)
      ? C.CharacterRef.idHi[ev.killer] * 4294967296 + C.CharacterRef.idLo[ev.killer]
      : 0;
    // Gold first: the killer pockets it straight into their wallet.
    if (owner !== 0 && this.opts.wallet && rules.gold) {
      const [glo, ghi] = rules.gold;
      const amount = glo + Math.floor(this.rand() * (Math.max(ghi, glo) - glo + 1));
      if (amount > 0) this.opts.wallet.grant(owner, amount, sim.currentTick);
    }
    if (this.pool.length === 0) return 0;
    const [lo, hi] = rules.rolls;
    const rolls = lo + Math.floor(this.rand() * (Math.max(hi, lo) - lo + 1));
    let n = 0;
    for (let i = 0; i < rolls; i++) {
      if (this.rand() >= rules.chance) continue;
      const def = this.pool[Math.floor(this.rand() * this.pool.length)];
      const a = this.rand() * Math.PI * 2;
      const r = this.rand() * SCATTER;
      this.opts.items.spawnDrop(sim, def, (ev.x ?? 0) + Math.cos(a) * r, (ev.z ?? 0) + Math.sin(a) * r, owner);
      n++;
    }
    return n;
  }

  /** Swap the creature table (rules hot reload, ED1). */
  setCreatures(creatures: CreaturesRules["creatures"]): void {
    this.creatures = creatures;
  }
}
