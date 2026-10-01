/**
 * Admin console arg parsing (roadmap A2): the text after the command.
 * A JSON object when it parses as one (`set {"entity":"me",...}`),
 * else the quoteless `{k:v,...}` shorthand (`set {entity:me,...}`,
 * numbers kept numeric), else the bare entity (`inspect me`).
 * Pure and unit-tested; the console component only wires it up.
 */

export function parseAdminArgs(rest: string): unknown {
  if (rest === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(rest);
    if (typeof parsed === "object" && parsed !== null) return parsed;
  } catch {
    // Fall through to the shorthand below.
  }
  const braced = /^\{\s*(.*?)\s*\}$/.exec(rest);
  if (!braced) return { entity: rest };
  const out: Record<string, unknown> = {};
  for (const part of braced[1].split(",")) {
    const i = part.indexOf(":");
    if (i < 0) return { entity: rest };
    const key = part.slice(0, i).trim();
    const raw = part.slice(i + 1).trim();
    if (!key) return { entity: rest };
    const num = Number(raw);
    out[key] = raw !== "" && !Number.isNaN(num) ? num : raw;
  }
  return out;
}
