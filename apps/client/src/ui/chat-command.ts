/** Chat-box slash commands (U6/U7): party ops, `/p`, `/w`, `/r`. Pure, so the box and tests share it. */

import { t } from "../i18n.js";
import type { ChatBroadcast, ChatChannel, GuildMessage, GuildRank, PartyMessage } from "@mmo-engine/protocol";

export type ChatCommand =
  | { kind: "say"; text: string }
  | { kind: "chat"; channel: ChatChannel; text: string; to?: string }
  | { kind: "party"; op: PartyMessage["op"]; name?: string }
  | { kind: "guild"; op: GuildMessage["op"]; name?: string; tag?: string; rank?: GuildRank; text?: string }
  | { kind: "friend"; name: string; on: boolean }
  | { kind: "block"; name: string; on: boolean }
  | { kind: "error"; text: string };

const RANKS = new Set(["recruit", "member", "officer", "leader"]);

/** Guild ops (S4): `/gcreate name tag` (the last word is the tag), `/ginvite`, `/gkick`, `/grank name rank`, `/gmotd`, `/gaccept`, `/gleave`. */
function parseGuildOp(op: string, words: string[], arg: string): ChatCommand | null {
  switch (op) {
    case "gcreate": {
      const tag = words.length >= 2 ? words[words.length - 1] : undefined;
      const name = words.slice(0, -1).join(" ");
      return tag && name ? { kind: "guild", op: "create", name, tag } : { kind: "error", text: t("cmd.gcreate") };
    }
    case "ginvite":
    case "gkick":
      return arg ? { kind: "guild", op: op === "ginvite" ? "invite" : "kick", name: arg } : { kind: "error", text: t("cmd.needs-name", { op }) };
    case "grank": {
      const [name, rank] = words;
      const r = rank?.toLowerCase();
      return name && r && RANKS.has(r)
        ? { kind: "guild", op: "setRank", name, rank: r as GuildRank }
        : { kind: "error", text: t("cmd.grank") };
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

/**
 * Who `/r` answers after `line` arrives: the sender of a whisper to `self`, or
 * `prev` for anything else (our own echoes, other channels, system notices).
 */
export function replyTarget(prev: string | null, line: ChatBroadcast, self: string | null): string | null {
  if (line.channel !== "whisper") return prev;
  if (self !== null && line.from.toLowerCase() === self.toLowerCase()) return prev;
  return line.from;
}

/**
 * Parses one submitted line; `channel` is the tab it was typed in and
 * `replyTo` the last character who whispered us (for `/r`).
 */
export function parseChatCommand(line: string, channel: ChatChannel, replyTo: string | null = null): ChatCommand {
  const text = line.trim();
  if (!text.startsWith("/")) return { kind: "chat", channel, text };
  const [cmd = "", ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(" ");
  const op = cmd.toLowerCase();
  if (NAMED_OPS.has(op)) {
    return arg ? { kind: "party", op: op as PartyMessage["op"], name: arg } : { kind: "error", text: t("cmd.needs-name", { op }) };
  }
  if (PLAIN_OPS.has(op)) return { kind: "party", op: op as PartyMessage["op"] };
  if (op === "friend" || op === "unfriend") {
    return arg ? { kind: "friend", name: arg, on: op === "friend" } : { kind: "error", text: t("cmd.needs-name", { op }) };
  }
  if (op === "block" || op === "unblock") {
    return arg ? { kind: "block", name: arg, on: op === "block" } : { kind: "error", text: t("cmd.needs-name", { op }) };
  }
  const guild = parseGuildOp(op, rest, arg);
  if (guild) return guild;
  if (op === "g" || op === "guild") return arg ? { kind: "chat", channel: "guild", text: arg } : { kind: "error", text: t("cmd.needs-message", { op: "g" }) };
  if (op === "p" || op === "party") return arg ? { kind: "chat", channel: "party", text: arg } : { kind: "error", text: t("cmd.needs-message", { op: "p" }) };
  if (op === "w" || op === "whisper") {
    const [to = "", ...msg] = rest;
    return to && msg.length ? { kind: "chat", channel: "whisper", text: msg.join(" "), to } : { kind: "error", text: t("cmd.whisper") };
  }
  if (op === "r" || op === "reply") {
    if (replyTo === null) return { kind: "error", text: t("cmd.no-reply") };
    return arg ? { kind: "chat", channel: "whisper", text: arg, to: replyTo } : { kind: "error", text: t("cmd.needs-message", { op: "r" }) };
  }
  return { kind: "error", text: t("cmd.unknown", { cmd }) };
}
