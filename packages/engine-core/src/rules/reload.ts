/**
 * Rules hot reload (roadmap ED1): the editor's Gameplay Tables save into
 * content/rules, and a running server picks the change up without a
 * restart. The watcher loads and validates off the tick; a valid set is
 * handed to the server between ticks (this system runs first), a bad one
 * is logged and the running rules stay.
 *
 * Read once at boot and so restart-only: the bag size (loot.bagSlots),
 * stats and the tables the editor doesn't edit, and the weapon a creature
 * already spawned holds.
 */

import * as fs from "node:fs";
import { RulesError, type RuleHooks } from "@mmo-engine/rules";
import type { SimSystem } from "../systems.js";
import type { SimWorld } from "../world.js";
import { loadGameRules, type GameRules } from "./boot.js";

/**
 * A RuleHooks that forwards to `current`: combat and death hold this one
 * instance, and a reload swaps what is behind it.
 */
export class HooksDelegate implements RuleHooks {
  constructor(public current: RuleHooks) {}
  computeDamage(input: Parameters<RuleHooks["computeDamage"]>[0]): ReturnType<RuleHooks["computeDamage"]> {
    return this.current.computeDamage(input);
  }
  resolveLanding(input: Parameters<RuleHooks["resolveLanding"]>[0]): string {
    return this.current.resolveLanding(input);
  }
  resolveDefence(input: Parameters<RuleHooks["resolveDefence"]>[0]): ReturnType<RuleHooks["resolveDefence"]> {
    return this.current.resolveDefence(input);
  }
  skillGain(input: Parameters<RuleHooks["skillGain"]>[0]): number {
    return this.current.skillGain(input);
  }
  onInjury(input: Parameters<RuleHooks["onInjury"]>[0]): ReturnType<RuleHooks["onInjury"]> {
    return this.current.onInjury(input);
  }
  onDeath(input: Parameters<RuleHooks["onDeath"]>[0]): ReturnType<RuleHooks["onDeath"]> {
    return this.current.onDeath(input);
  }
  onRespawn(input: Parameters<RuleHooks["onRespawn"]>[0]): ReturnType<RuleHooks["onRespawn"]> {
    return this.current.onRespawn(input);
  }
}

export interface RulesReloaderOptions {
  /** Quiet time after the last file event before reloading (an editor save writes a temp file, then renames). */
  debounceMs?: number;
  load?: (dir: string) => GameRules;
  log?: (line: string) => void;
}

export class RulesReloader implements SimSystem {
  readonly name = "rules";
  private pending: GameRules | null = null;
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly debounceMs: number;
  private readonly load: (dir: string) => GameRules;
  private readonly log: (line: string) => void;

  constructor(
    readonly dir: string,
    private readonly apply: (game: GameRules) => void,
    opts: RulesReloaderOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 150;
    this.load = opts.load ?? ((d) => loadGameRules(d));
    this.log = opts.log ?? ((l) => console.log(l));
  }

  /** Watch the rules folder; each settled change is reloaded. */
  watch(): void {
    if (this.watcher) return;
    this.watcher = fs.watch(this.dir, (_event, file) => {
      if (file && !String(file).endsWith(".json")) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.reload();
      }, this.debounceMs);
      this.timer.unref();
    });
    this.watcher.unref();
  }

  /**
   * Load and check the rules now. A valid set waits for the next tick;
   * a bad one is logged and dropped. Returns whether it was accepted.
   */
  reload(): boolean {
    try {
      this.pending = this.load(this.dir);
      return true;
    } catch (err) {
      if (!(err instanceof RulesError)) throw err;
      this.log(`[rules] reload refused, keeping the running rules: ${err.message}`);
      return false;
    }
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  step(_sim: SimWorld, _dt: number): void {
    if (this.pending === null) return;
    const game = this.pending;
    this.pending = null;
    this.apply(game);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}
