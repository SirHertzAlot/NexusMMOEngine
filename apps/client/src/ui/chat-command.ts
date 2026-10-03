/** Chat-box slash commands (U6/U7): party ops, `/p`, `/w`. Pure, so the box and tests share it. */

import type { ChatChannel, PartyMessage } from "@mmo-engine/protocol";

export type ChatCommand =
  | { kind: "say"; text: string }
  | { kind: "chat"; channel: ChatChannel; text: string; to?: string }
  | { kind: "party"; op: PartyMessage["op"]; name?: string }
  | { kind: "error"; text: string };

const NAMED_OPS = new Set(["invite", "kick", "promote"]);
const PLAIN_OPS = new Set(["accept", "leave"]);

/** Parses one submitted line; `channel` is the tab it was typed in. */
export function parseChatCommand(line: string, channel: ChatChannel): ChatCommand {
  const text = line.trim();
  if (!text.startsWith("/")) return { kind: "chat", channel, text };
  const [cmd = "", ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(" ");
  const op = cmd.toLowerCase();
  if (NAMED_OPS.has(op)) {
    return arg ? { kind: "party", op: op as PartyMessage["op"], name: arg } : { kind: "error", text: `/${op} needs a name` };
  }
  if (PLAIN_OPS.has(op)) return { kind: "party", op: op as PartyMessage["op"] };
  if (op === "p" || op === "party") return arg ? { kind: "chat", channel: "party", text: arg } : { kind: "error", text: "/p needs a message" };
  if (op === "w" || op === "whisper") {
    const [to = "", ...msg] = rest;
    return to && msg.length ? { kind: "chat", channel: "whisper", text: msg.join(" "), to } : { kind: "error", text: "/w needs a name and a message" };
  }
  return { kind: "error", text: `unknown command /${cmd}` };
}
