/**
 * The world's day: every client derives the time of day from the server
 * tick, so all players see the same sun, sky and light at the same moment
 * without a message per frame. The server sends its clock in the welcome
 * (`day`); a server that sends none has no day cycle.
 */

export interface DayClock {
  /** Real seconds in one game day (> 0). */
  seconds: number;
  /** Time of day at tick 0, as a fraction of the day (0 midnight, 0.25 dawn, 0.5 noon, 0.75 dusk). */
  offset: number;
}

/** Time of day (0..1, 0 = midnight) at a server tick. */
export function timeOfDayAt(day: DayClock, tick: number, tickHz: number): number {
  const t = day.offset + tick / tickHz / day.seconds;
  return ((t % 1) + 1) % 1;
}

/** A time of day as a 24 h clock, e.g. 0.6042 -> "14:30". */
export function formatTimeOfDay(time: number): string {
  const t = ((time % 1) + 1) % 1;
  const minutes = Math.floor(t * 24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
