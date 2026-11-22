/**
 * Forge shell chrome (docs/EDITOR-UI-2026.md §3 items 1 and 6, slice EU2).
 *
 * The bar's whole claim is that it reports state the editor already
 * holds, so these tests pin the mapping from that state to what it
 * draws — and that the only thing on it anyone can press is the
 * navigation the shell already has.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ForgeContextBar,
  branchChip,
  crumbs,
  serverChip,
} from "../src/ui/forge-chrome.js";
import type { VcsFile } from "../src/vcs-client.js";
import { editorSelection } from "../src/ui/editor-selection.js";

function file(over: Partial<VcsFile> = {}): VcsFile {
  return {
    path: "content/scenes/arena.json",
    docType: "scene",
    status: "modified",
    staged: false,
    conflicted: false,
    ...over,
  };
}

function render(
  props: Partial<React.ComponentProps<typeof ForgeContextBar>> = {},
): string {
  return renderToStaticMarkup(
    React.createElement(ForgeContextBar, {
      workspaceLabel: "Scene",
      viewLabel: "ECS Inspector",
      problems: 0,
      onGoWorkspace: () => undefined,
      onOpenProblems: () => undefined,
      vcs: null,
      ...props,
    }),
  );
}

describe("forge context bar — the path", () => {
  it("names the workspace, then the view", () => {
    assert.deepEqual(crumbs({ workspaceLabel: "Scene", viewLabel: "ECS Inspector" }), [
      { id: "workspace", label: "Scene", nav: true },
      { id: "view", label: "ECS Inspector" },
    ]);
  });

  it("leaves the tail off when nothing is selected", () => {
    const path = crumbs({ workspaceLabel: "Scene" });
    assert.equal(path.length, 1);
    assert.equal(path[0]?.id, "workspace");
  });

  it("adds the selection last when there is one", () => {
    const path = crumbs({
      workspaceLabel: "Scene",
      viewLabel: "ECS Inspector",
      selectionLabel: "Entity 13",
    });
    assert.equal(path.at(-1)?.label, "Entity 13");
  });

  it("draws the live selection from the shared selection model", () => {
    editorSelection.select({
      source: "entity-list",
      kind: "entity",
      id: "13",
      label: "Entity 13",
      components: [],
    });
    try {
      assert.match(render(), /Entity 13/);
    } finally {
      editorSelection.clear("entity-list");
    }
    assert.doesNotMatch(render(), /Entity 13/);
  });
});

describe("forge context bar — the chips", () => {
  it("speaks the play controller's own state names", () => {
    assert.deepEqual(serverChip("running"), { label: "running", tone: "ok" });
    assert.deepEqual(serverChip("starting"), { label: "starting", tone: "warn" });
    assert.deepEqual(serverChip("error"), { label: "failed", tone: "bad" });
    assert.deepEqual(serverChip("idle"), { label: "stopped", tone: "idle" });
  });

  it("reports a clean tree as clean", () => {
    assert.deepEqual(branchChip({ branch: "main", files: [] }), {
      label: "main",
      detail: "clean",
      tone: "ok",
    });
  });

  it("counts changed files", () => {
    const chip = branchChip({ branch: "feat/x", files: [file(), file({ path: "a.json" })] });
    assert.equal(chip.detail, "2 changed");
    assert.equal(chip.tone, "warn");
  });

  it("lets a conflict outrank a plain change", () => {
    const chip = branchChip({
      branch: "feat/x",
      files: [file(), file({ path: "b.json", conflicted: true })],
    });
    assert.equal(chip.detail, "1 conflict");
    assert.equal(chip.tone, "bad");
  });

  it("says so when there is no repository rather than guessing a branch", () => {
    assert.equal(branchChip(null).label, "no repository");
    assert.equal(branchChip(null).tone, "idle");
  });

  it("shows the branch the host reported", () => {
    const html = render({ vcs: { branch: "claude/project-thread", files: [file()] } });
    assert.match(html, /claude\/project-thread/);
    assert.match(html, /1 changed/);
  });

  it("reads the problem total the shell passes, and pluralises it", () => {
    assert.match(render({ problems: 0 }), /no problems/);
    assert.match(render({ problems: 1 }), /1 problem</);
    assert.match(render({ problems: 4 }), /4 problems</);
  });
});

describe("forge context bar — what it does not do", () => {
  it("edits nothing: no field, and only the two navigations as buttons", () => {
    const html = render({ problems: 2 });
    assert.doesNotMatch(html, /<input/i);
    assert.doesNotMatch(html, /<select/i);
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    // One crumb back to the workspace, one chip that opens Problems.
    assert.equal(buttons.length, 2, `expected 2 buttons, got ${buttons.length}`);
  });
});
