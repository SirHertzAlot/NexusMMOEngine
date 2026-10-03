import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseChatCommand } from "../src/ui/chat-command.js";

describe("parseChatCommand", () => {
  it("plain text goes to the active channel", () => {
    assert.deepEqual(parseChatCommand(" hello ", "yell"), { kind: "chat", channel: "yell", text: "hello" });
  });
  it("party ops", () => {
    assert.deepEqual(parseChatCommand("/invite Bob", "say"), { kind: "party", op: "invite", name: "Bob" });
    assert.deepEqual(parseChatCommand("/ACCEPT", "say"), { kind: "party", op: "accept" });
    assert.deepEqual(parseChatCommand("/leave", "say"), { kind: "party", op: "leave" });
    assert.equal(parseChatCommand("/kick", "say").kind, "error");
  });
  it("/p and /w", () => {
    assert.deepEqual(parseChatCommand("/p on me", "say"), { kind: "chat", channel: "party", text: "on me" });
    assert.deepEqual(parseChatCommand("/w Ann hi there", "say"), { kind: "chat", channel: "whisper", text: "hi there", to: "Ann" });
    assert.equal(parseChatCommand("/w Ann", "say").kind, "error");
    assert.equal(parseChatCommand("/zap", "say").kind, "error");
  });
  it("guild chat and ops", () => {
    assert.deepEqual(parseChatCommand("/g raid at 8", "say"), { kind: "chat", channel: "guild", text: "raid at 8" });
    assert.equal(parseChatCommand("/g", "say").kind, "error");
    assert.deepEqual(parseChatCommand("/gcreate Night Owls owl", "say"), { kind: "guild", op: "create", name: "Night Owls", tag: "owl" });
    assert.equal(parseChatCommand("/gcreate Owls", "say").kind, "error");
    assert.deepEqual(parseChatCommand("/ginvite Bob", "say"), { kind: "guild", op: "invite", name: "Bob" });
    assert.deepEqual(parseChatCommand("/gkick Bob", "say"), { kind: "guild", op: "kick", name: "Bob" });
    assert.equal(parseChatCommand("/gkick", "say").kind, "error");
    assert.deepEqual(parseChatCommand("/grank Bob Officer", "say"), { kind: "guild", op: "setRank", name: "Bob", rank: "officer" });
    assert.equal(parseChatCommand("/grank Bob king", "say").kind, "error");
    assert.deepEqual(parseChatCommand("/gmotd raid at 8", "say"), { kind: "guild", op: "motd", text: "raid at 8" });
    assert.deepEqual(parseChatCommand("/gmotd", "say"), { kind: "guild", op: "motd", text: "" });
    assert.deepEqual(parseChatCommand("/gaccept", "say"), { kind: "guild", op: "accept" });
    assert.deepEqual(parseChatCommand("/gleave", "say"), { kind: "guild", op: "leave" });
  });
});
