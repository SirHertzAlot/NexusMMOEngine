/**
 * Structured network lifecycle logs (E6): one JSON object per line,
 * `{ ts, level, component, event, ...fields }`. Fields that could carry
 * secrets or player data (tokens, payloads, passwords) are refused here,
 * so no call site can leak them by accident.
 */
export type LogLevel = "info" | "warn" | "error";
export type LogComponent = "edge" | "channel" | "core";
export const LIFECYCLE_EVENTS = ["ws.open", "ws.close", "channel.up", "channel.down", "channel.reconnect", "heartbeat.missed", "frame.oversized"] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

const FORBIDDEN = /token|payload|password|secret|hash|username/i;

export interface NetLogger {
  log(level: LogLevel, event: LifecycleEvent, fields?: Record<string, string | number | boolean>): void;
}

export function netLogger(component: LogComponent, write: (line: string) => void = (l) => process.stdout.write(l + "\n"), now: () => Date = () => new Date()): NetLogger {
  return {
    log(level, event, fields = {}) {
      const clean: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (FORBIDDEN.test(k)) continue;
        clean[k] = v;
      }
      write(JSON.stringify({ ts: now().toISOString(), level, component, event, ...clean }));
    },
  };
}
