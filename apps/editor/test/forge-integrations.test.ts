/**
 * Forge integrations status list (docs/EDITOR-UI-2026.md §2.6, slice EU5).
 *
 * The thing worth protecting here is honesty. A status list that reads
 * "connected" because a fetch failed, or that quietly omits the two
 * integrations we have not built, is worse than no list at all. So the
 * tests pin: an unreachable read is reported as unreachable and never
 * as healthy; the missing integrations are always present and always
 * say which slice would build them; and nothing on the list acts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ForgeIntegrationsView,
  integrationRows,
  type IntegrationInputs,
} from "../src/ui/forge-integrations.js";
import type { VcsFile } from "../src/vcs-client.js";

function file(path: string, over: Partial<VcsFile> = {}): VcsFile {
  return { path, docType: "scene", status: "modified", staged: false, conflicted: false, ...over };
}

/** Everything unreachable: the state the panel is in before its first read. */
const COLD: IntegrationInputs = { play: "idle", vcs: null, locks: null, graph: null, code: null };

const WARM: IntegrationInputs = {
  play: "running",
  vcs: { branch: "main", files: [] },
  locks: {},
  graph: { state: "synced", graphCommit: "abc1234", compareCommit: "abc1234", compareLabel: "repo HEAD", reason: "synced · abc1234" },
  code: { repoRoot: "/home/sam/engine", editor: { command: "code", found: true, version: "1.96.2" } },
};

const row = (input: IntegrationInputs, id: string) => {
  const r = integrationRows(input).find((x) => x.id === id);
  assert.ok(r, `no row for ${id}`);
  return r;
};

describe("an unreachable read is never reported as healthy", () => {
  it("says so for every connection when nothing has been read", () => {
    for (const r of integrationRows(COLD)) {
      assert.notEqual(r.state, "ok", `${r.id} claimed to be connected with no data`);
    }
  });

  it("names what is missing rather than leaving the detail blank", () => {
    assert.match(row(COLD, "worktree").detail, /no repository|not serving/);
    assert.match(row(COLD, "locks").detail, /unavailable/);
    assert.equal(row(COLD, "graph").detail, "not loaded");
  });
});

describe("the worktree row", () => {
  it("is clean, changed, or conflicted — and a conflict outranks a change", () => {
    assert.equal(row(WARM, "worktree").state, "ok");
    assert.equal(row({ ...WARM, vcs: { branch: "b", files: [file("a.json")] } }, "worktree").state, "warn");
    const conflicted = row(
      { ...WARM, vcs: { branch: "b", files: [file("a.json"), file("c.json", { conflicted: true })] } },
      "worktree",
    );
    assert.equal(conflicted.state, "bad");
    assert.match(conflicted.detail, /1 conflict to resolve/);
  });

  it("counts files with a plural that reads", () => {
    assert.match(row({ ...WARM, vcs: { branch: "b", files: [file("a.json")] } }, "worktree").detail, /1 file changed/);
    assert.match(
      row({ ...WARM, vcs: { branch: "b", files: [file("a.json"), file("b.json")] } }, "worktree").detail,
      /2 files changed/,
    );
  });
});

describe("the conflict guard row", () => {
  it("is the advisory soft locks, counted by file and by person", () => {
    const locks = {
      "content/scenes/arena.json": { owner: "sam", since: "2026-11-26T10:00:00Z" },
      "content/rules/combat.json": { owner: "sam", since: "2026-11-26T10:05:00Z" },
    };
    const r = row({ ...WARM, locks }, "locks");
    assert.equal(r.state, "warn");
    assert.match(r.detail, /2 files locked by 1 person/);
  });

  it("holding none is fine, not missing", () => {
    assert.equal(row(WARM, "locks").state, "ok");
  });
});

describe("the runtime row", () => {
  it("is connected only while the server is running", () => {
    assert.equal(row(WARM, "runtime").state, "ok");
    assert.equal(row({ ...WARM, play: "idle" }, "runtime").state, "absent");
    assert.equal(row({ ...WARM, play: "error" }, "runtime").state, "bad");
  });
});

describe("what we have not built", () => {
  it("lists Blender always, as not set up, naming the slice that would build it", () => {
    for (const input of [COLD, WARM]) {
      const blender = row(input, "blender");
      assert.equal(blender.state, "absent");
      assert.match(blender.detail, /EU10/);
    }
  });

  it("reports the VS Code handoff from the probe, never from hope", () => {
    // Not probed: absent, and it says why rather than claiming a failure.
    assert.equal(row(COLD, "vscode").state, "absent");
    assert.match(row(COLD, "vscode").detail, /not probed/);
    // `code` found: connected, with the version the host read.
    assert.equal(row(WARM, "vscode").state, "ok");
    assert.match(row(WARM, "vscode").detail, /1\.96\.2/);
    // `code` missing is "not set up", not "blocked": the URI and the
    // copyable command still work without it.
    const without: IntegrationInputs = {
      ...WARM,
      code: { repoRoot: "/home/sam/engine", editor: { command: "code", found: false, version: null } },
    };
    assert.equal(row(without, "vscode").state, "absent");
    assert.match(row(without, "vscode").detail, /not on PATH/);
  });

  it("keeps a fixed order, so the list does not reshuffle as states change", () => {
    assert.deepEqual(
      integrationRows(COLD).map((r) => r.id),
      integrationRows(WARM).map((r) => r.id),
    );
  });
});

describe("the panel", () => {
  it("counts the connected ones honestly", () => {
    const html = renderToStaticMarkup(
      React.createElement(ForgeIntegrationsView, { rows: integrationRows(COLD) }),
    );
    assert.match(html, /0 of 6 connected/);
    const warm = renderToStaticMarkup(
      React.createElement(ForgeIntegrationsView, { rows: integrationRows(WARM) }),
    );
    assert.match(warm, /5 of 6 connected/);
  });

  it("acts on nothing: it is a read-out", () => {
    const html = renderToStaticMarkup(
      React.createElement(ForgeIntegrationsView, { rows: integrationRows(WARM) }),
    );
    assert.doesNotMatch(html, /<button/i);
    assert.doesNotMatch(html, /<input/i);
  });
});
