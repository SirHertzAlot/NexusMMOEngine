/** ChatPanel speaker labels (U6): whispers say which way they went. */

import "./i18n-setup.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatBroadcast } from "@mmo-engine/protocol";
import { speakerLabel } from "../src/ui/chat-panel.js";

const line = (channel: ChatBroadcast["channel"], from: string, to?: string): ChatBroadcast => ({ kind: "chat", channel, text: "x", from, entity: "1", to });

describe("speakerLabel", () => {
  it("names the speaker on open channels", () => {
    assert.equal(speakerLabel(line("say", "Ann"), "Me"), "Ann");
  });
  it("marks whispers in and out", () => {
    assert.equal(speakerLabel(line("whisper", "Ann", "Me"), "Me"), "from Ann");
    assert.equal(speakerLabel(line("whisper", "me", "Bob"), "Me"), "to Bob");
  });
});
