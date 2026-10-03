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
