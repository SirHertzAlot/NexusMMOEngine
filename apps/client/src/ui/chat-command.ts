/** Chat-box slash commands (U6/U7): party ops, `/p`, `/w`. Pure, so the box and tests share it. */

import type { ChatChannel, GuildMessage, GuildRank, PartyMessage } from "@mmo-engine/protocol";

export type ChatCommand =
  | { kind: "say"; text: string }
  | { kind: "chat"; channel: ChatChannel; text: string; to?: string }
  | { kind: "party"; op: PartyMessage["op"]; name?: string }
  | { kind: "guild"; op: GuildMessage["op"]; name?: string; tag?: string; rank?: GuildRank; text?: string }
  | { kind: "friend"; name: string; on: boolean }
  | { kind: "error"; text: string };

const RANKS = new Set(["recruit", "member", "officer", "leader"]);

/** Guild ops (S4): `/gcreate name tag` (the last word is the tag), `/ginvite`, `/gkick`, `/grank name rank`, `/gmotd`, `/gaccept`, `/gleave`. */
function parseGuildOp(op: string, words: string[], arg: string): ChatCommand | null {
  switch (op) {
    case "gcreate": {
      const tag = words.length >= 2 ? words[words.length - 1] : undefined;
      const name = words.slice(0, -1).join(" ");
      return tag && name ? { kind: "guild", op: "create", name, tag } : { kind: "error", text: "/gcreate needs a name and a tag" };
    }
    case "ginvite":
    case "gkick":
      return arg ? { kind: "guild", op: op === "ginvite" ? "invite" : "kick", name: arg } : { kind: "error", text: `/${op} needs a name` };
    case "grank": {
      const [name, rank] = words;
      const r = rank?.toLowerCase();
      return name && r && RANKS.has(r)
        ? { kind: "guild", op: "setRank", name, rank: r as GuildRank }
        : { kind: "error", text: "/grank needs a name and a rank (recruit, member, officer, leader)" };
    }
    case "gmotd":
      return { kind: "guild", op: "motd", text: arg };
    case "gaccept":
      return { kind: "guild", op: "accept" };
    case "gleave":
      return { kind: "guild", op: "leave" };
    default:
      return null;
  }
}

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
  if (op === "friend" || op === "unfriend") {
    return arg ? { kind: "friend", name: arg, on: op === "friend" } : { kind: "error", text: `/${op} needs a name` };
  }
  const guild = parseGuildOp(op, rest, arg);
  if (guild) return guild;
  if (op === "g" || op === "guild") return arg ? { kind: "chat", channel: "guild", text: arg } : { kind: "error", text: "/g needs a message" };
  if (op === "p" || op === "party") return arg ? { kind: "chat", channel: "party", text: arg } : { kind: "error", text: "/p needs a message" };
  if (op === "w" || op === "whisper") {
    const [to = "", ...msg] = rest;
    return to && msg.length ? { kind: "chat", channel: "whisper", text: msg.join(" "), to } : { kind: "error", text: "/w needs a name and a message" };
  }
  return { kind: "error", text: `unknown command /${cmd}` };
}
