import type { ChannelLike } from "./router.js";

/**
 * Placeholder core channel until E2 ships the real client. Every request
 * fails, so core-bound packets answer `core.unavailable`.
 */
export class StubChannel implements ChannelLike { readonly status = "unknown" as const; request(): Promise<unknown> { throw new Error("core channel not yet implemented (E2)"); } }
