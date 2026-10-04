/** Wire shapes of the internal edge<->core channel (slice E2 of docs/EDGE-CORE-SPLIT.md). */
export interface ChannelPacket { type: string; id: string; payload: unknown; }
export interface ChannelResponse { type: string; id: string; payload: unknown; error?: string; }
export interface ChannelLike {
  request(type: string, payload: unknown, id: string, timeoutMs?: number): Promise<unknown>;
  notify(type: string, payload: unknown): void;
  onPush(type: string, handler: (payload: unknown) => void): void;
  onStatus(cb: (s: "up" | "down" | "unknown") => void): void;
  readonly status: "up" | "down" | "unknown";
}
