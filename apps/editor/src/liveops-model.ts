/**
 * Live ops (roadmap EA26): pure helpers for the admin console and quick
 * controls. The commands are the server's own (gateway `onAdmin`); nothing
 * here knows more than their usage strings.
 */

export interface ConsoleCommand {
  command: string;
  args?: Record<string, unknown>;
}

function scalar(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && Number.isFinite(Number(v))) return Number(v);
  return v;
}

/**
 * One console line: `heal`, `teleport x=10 z=-4`, `set {"entity":"me",...}`.
 * Returns an error string for a line that cannot be a command.
 */
export function parseConsoleLine(line: string): ConsoleCommand | { error: string } {
  const text = line.trim();
  const m = /^([a-z]+)(?:\s+(.*))?$/.exec(text);
  if (!m) return { error: "start with a command name, e.g. help" };
  const [, command, rest] = m;
  if (rest === undefined || rest === "") return { command };
  if (rest.startsWith("{")) {
    try {
      const parsed = JSON.parse(rest) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "arguments must be a JSON object" };
      return { command, args: parsed as Record<string, unknown> };
    } catch {
      return { error: "arguments are not valid JSON" };
    }
  }
  const args: Record<string, unknown> = {};
  for (const tok of rest.split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq <= 0) return { error: `"${tok}" is not key=value` };
    args[tok.slice(0, eq)] = scalar(tok.slice(eq + 1));
  }
  return { command, args };
}

/** The command names the server's `help` lists. */
export function parseHelp(message: string): string[] {
  const m = /^commands:\s*(.*)$/.exec(message.trim());
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
}

export const WEATHERS = ["auto", "clear", "rain", "snow", "ash"] as const;
export type Weather = (typeof WEATHERS)[number];

/** `weather: rain (forced)` or `weather: auto (...)` → the current setting, or null. */
export function parseWeather(message: string): Weather | null {
  const m = /^weather:\s*([a-z]+)/.exec(message);
  return m && (WEATHERS as readonly string[]).includes(m[1]) ? (m[1] as Weather) : null;
}

/** `07:30 (a day lasts 2400 s)` → { hour, minute }, or null. */
export function parseTimeOfDay(message: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(message.trim());
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

export function timeArgs(hour: number, minute = 0): { hour: number; minute: number } | { error: string } {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { error: "hour is 0 to 23" };
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return { error: "minute is 0 to 59" };
  return { hour, minute };
}

/** Milliseconds as `1 h 02 m`, `4 m 09 s`, `12 s`. */
export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (h > 0) return `${h} h ${pad(m)} m`;
  if (m > 0) return `${m} m ${pad(s % 60)} s`;
  return `${s} s`;
}
