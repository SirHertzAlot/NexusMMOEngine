/**
 * Generation events: what the generator decided and why, kept apart from the
 * manifest (spec §23). Stages emit; the log keeps everything and hands back
 * what a verbosity level asks for. Emitting is cheap, so a stage never checks
 * the level itself.
 */

export const VERBOSITY = ["silent", "summary", "normal", "verbose", "debug"] as const;
export type Verbosity = (typeof VERBOSITY)[number];

export interface GenerationEvent {
  sequence: number;
  level: Exclude<Verbosity, "silent">;
  stage: string;
  event: string;
  data: Record<string, unknown>;
}

export class EventLog {
  private readonly all: GenerationEvent[] = [];

  emit(level: GenerationEvent["level"], stage: string, event: string, data: Record<string, unknown> = {}): void {
    this.all.push({ sequence: this.all.length + 1, level, stage, event, data });
  }

  /** The events at or below `verbosity` (silent: none), in sequence order. */
  events(verbosity: Verbosity): GenerationEvent[] {
    const rank = VERBOSITY.indexOf(verbosity);
    return this.all.filter((e) => VERBOSITY.indexOf(e.level) <= rank);
  }
}
