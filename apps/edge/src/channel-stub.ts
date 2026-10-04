import type { ChannelLike } from "@mmo-engine/channel";

/**
 * A channel that never reaches the core: every request fails, so
 * core-bound packets answer `core.unavailable`. The edge boots with the
 * real `ChannelClient` since E2; tests keep using this.
 */
export class StubChannel implements ChannelLike {
  readonly status = "unknown" as const;
  request(): Promise<unknown> { throw new Error("core channel not yet implemented (E2)"); }
  notify(): void {}
  onPush(): void {}
  onStatus(): void {}
}
