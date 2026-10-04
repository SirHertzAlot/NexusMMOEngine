/**
 * The last 3600 ticks (two minutes at 30 Hz) of the core's gameplay
 * events, fed by the `tick.events` push (E3). Content systems on the edge
 * read it (Q9's mythic evaluator).
 */
export interface TickEntry { tick: number; events: unknown[]; }
const MAX_TICKS = 3600;
const buf: TickEntry[] = [];
export function pushTick(tick: number, events: unknown[]): void {
  buf.push({ tick, events });
  while (buf.length > MAX_TICKS) buf.shift();
}
export function getTickBuffer(): TickEntry[] { return buf; }
