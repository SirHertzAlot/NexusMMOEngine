/**
 * Gateway extensions: features that talk to players over the gateway but
 * live outside it (quests and dialog first). An extension owns one 0x11
 * `kind`: the gateway hands it every message of that kind from a character
 * in the world, and tells it when the character enters and leaves. It
 * answers through the player handle, never through gateway internals.
 */

/** A character in the world, as the gateway lends it to an extension. */
export interface ExtensionPlayer {
  /** The character's id (null: an account playing without a character). */
  readonly characterId: number | null;
  /** The account (what a token for another world is issued to). */
  readonly username: string;
  readonly name: string;
  /** The avatar's entity, or -1 when it is gone. */
  entity(): number;
  send(msg: object): void;
  /** The bag changed outside the gateway: send the character its inventory. */
  refreshInventory(): void;
}

/** A gateway feature living outside the gateway: its 0x11 `kind`, its messages, and enter / leave. */
export interface GatewayExtension {
  readonly kind: string;
  onMessage(player: ExtensionPlayer, raw: unknown): void;
  onEnter?(player: ExtensionPlayer): void;
  onLeave?(player: ExtensionPlayer): void;
}

/**
 * What the gateway asks of the extension registered under `kind` `"quest"`
 * (`ES5o`).
 *
 * Three questions, all optional, because the extension answering is a
 * game's and need not offer any of them: which residents an active step has
 * pinned (so their entities ride the interest set), which NPC a resident
 * speaks for, and that a player is talking to one. The gateway asked these
 * of an inline `as unknown as { ... }` shape written out at four call sites,
 * which meant four places to keep in step and no name to look up. This is
 * that shape, once.
 *
 * Absent, or an extension that offers none of them: a quest giver is an
 * ordinary resident with an ordinary line, which is what a server with no
 * quests has always shown.
 */
export interface QuestExtension extends GatewayExtension {
  /** The residents an active step has pinned, by name. */
  pinnedResidentsOf?(characterId: number | null): string[];
  /** The NPC this resident speaks for, if it is a giver. */
  npcOfResident?(resident: string): string | undefined;
  /** This player is talking to that NPC. */
  talkAt?(player: ExtensionPlayer, npcId: string): void;
}
