/**
 * CombatSystem — server-authoritative combat moves (protocol combat.ts):
 * attacks and their combos, the guard, the dodge roll.
 *
 * It reads each character's PlayerIntent buttons — Attack and Dodge act
 * on the press, Block while held — runs the move the character is in (the
 * Action component), and moves it: during a move the walk is scaled down
 * (the move's moveScale) and the move's own advance (a lunge, the roll)
 * carries the character along the move's facing. Clients only play the
 * clip of the move they are told about, from its start tick.
 *
 * Combos: an attack pressed in a hit's chain window is queued; when the
 * hit lands (branchAt) the queued hit starts — facing wherever the player
 * now looks — or, with nothing queued, the hit's recovery plays. New
 * moves start only on the ground.
 *
 * Runs after IntentSystem (which sets the walking velocity) and before
 * IntegrateSystem (which moves by it). Damage and hit reactions are not
 * here yet.
 */

import { defineQuery, hasComponent } from "bitecs";
import { combatMove, IntentButton, LocomotionMode, Move, moveTravel, type CombatMove } from "@mmo-engine/protocol";
import { Action, Locomotion, PlayerIntent, Velocity } from "./components.js";
import type { SimSystem } from "./systems.js";
import type { SimWorld } from "./world.js";

export class CombatSystem implements SimSystem {
  readonly name = "combat";
  private readonly query = defineQuery([PlayerIntent, Velocity, Action]);
  /** Buttons held last tick, per entity (presses are the new bits). */
  private readonly held = new Map<number, number>();
  /** Entities with a follow-up attack queued. */
  private readonly queued = new Set<number>();

  constructor(private readonly tickHz = 30) {}

  step(sim: SimWorld, dt: number): void {
    const eids = this.query(sim.ecs);
    if (this.held.size > eids.length) {
      const live = new Set<number>(eids as unknown as number[]);
      for (const e of this.held.keys()) if (!live.has(e)) this.held.delete(e);
      for (const e of this.queued) if (!live.has(e)) this.queued.delete(e);
    }
    const tick = sim.currentTick;
    for (let i = 0; i < eids.length; i++) {
      const e = eids[i] as number;
      const buttons = PlayerIntent.buttons[e];
      const pressed = buttons & ~(this.held.get(e) ?? 0);
      this.held.set(e, buttons);
      const look = PlayerIntent.lookYaw[e];

      let move = combatMove(Action.move[e]);
      let t = move ? (tick - Action.started[e]) / this.tickHz : 0;
      if (move) {
        if ((pressed & IntentButton.Attack) !== 0 && move.chain && t >= move.chain.from && t <= move.chain.to) {
          this.queued.add(e);
        }
        if (move.held) {
          if ((buttons & IntentButton.Block) === 0) move = this.end(e);
          else if ((pressed & IntentButton.Attack) !== 0) move = this.start(sim, e, Move.ShieldBash, look);
          else Action.yaw[e] = look; // a guard faces where you look
        } else if (move.branchAt !== undefined && t >= move.branchAt && (this.queued.has(e) || move.recovery !== undefined)) {
          move = this.queued.has(e) && move.chain
            ? this.start(sim, e, move.chain.next, look)
            : move.recovery !== undefined
              ? this.start(sim, e, move.recovery, Action.yaw[e])
              : move;
        } else if (t >= move.duration) {
          move = this.end(e);
        }
        if (move && Action.started[e] === tick) t = 0;
      }

      const grounded = !hasComponent(sim.ecs, Locomotion, e) || Locomotion.mode[e] === LocomotionMode.Ground;
      if (!move && grounded) {
        const mx = PlayerIntent.mx[e];
        const mz = PlayerIntent.mz[e];
        if ((pressed & IntentButton.Dodge) !== 0) {
          move = this.start(sim, e, Move.Roll, mx !== 0 || mz !== 0 ? Math.atan2(mx, mz) : look);
        } else if ((pressed & IntentButton.Attack) !== 0) {
          move = this.start(sim, e, Move.SwordA, look);
        } else if ((buttons & IntentButton.Block) !== 0) {
          move = this.start(sim, e, Move.Guard, look);
        }
        t = 0;
      }

      if (move) {
        // Walking slowed to the move's allowance, plus the move's own advance
        // over this tick, along its facing.
        Velocity.lx[e] *= move.moveScale;
        Velocity.lz[e] *= move.moveScale;
        const d = moveTravel(move, t + dt) - moveTravel(move, t);
        if (d !== 0) {
          const yaw = Action.yaw[e];
          Velocity.lx[e] += (Math.sin(yaw) * d) / dt;
          Velocity.lz[e] += (Math.cos(yaw) * d) / dt;
        }
      }
    }
  }

  private start(sim: SimWorld, e: number, id: number, yaw: number): CombatMove | undefined {
    Action.move[e] = id;
    Action.started[e] = sim.currentTick;
    Action.seq[e] = (Action.seq[e] + 1) & 0xff;
    Action.yaw[e] = yaw;
    this.queued.delete(e);
    return combatMove(id);
  }

  private end(e: number): undefined {
    Action.move[e] = Move.None;
    this.queued.delete(e);
    return undefined;
  }
}
