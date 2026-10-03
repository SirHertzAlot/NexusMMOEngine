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
});
