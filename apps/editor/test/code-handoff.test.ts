/**
 * The VS Code handoff (docs/EDITOR-UI-2026.md §2.7, slice EU9).
 *
 * The thing worth protecting here is the refusal, not the convenience:
 * a route that spawns a program with a path from a request must not be
 * talked into a path outside the repository, and must keep the
 * `assets/` boundary `vcs-host.ts` holds — the licensed art is served
 * by the dev server and opened by nothing else. The rest of these
 * assertions pin the parsing of the `file:line` form the ECS graph
 * records, so a click lands on the line and not on line 1.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  codeCommand,
  parseSourceRef,
  refLabel,
  refuseOpen,
  vscodeUri,
} from "../src/code-handoff.js";
import {
  codeArgs,
  forgetEditorProbe,
  handleCodeRoute,
  refFromBody,
  resolveRef,
  type CodeHostDeps,
} from "../src/code-host.js";
import { chipTitle, handoffSteps } from "../src/ui/open-in-code.js";
import { ForgeSystemsView, systemSignatures } from "../src/ui/forge-systems.js";
import { indexEcsGraph, type EcsGraphPayload } from "../src/ecs-graph-model.js";

describe("reading the graph's file:line", () => {
  it("splits a system node's source", () => {
    assert.deepEqual(parseSourceRef("packages/engine-core/src/abilities.ts:51"), {
      relPath: "packages/engine-core/src/abilities.ts",
      line: 51,
    });
  });

  it("keeps the line when a column follows it", () => {
    assert.deepEqual(parseSourceRef("a/b.ts:51:4"), { relPath: "a/b.ts", line: 51 });
  });

  it("accepts a file with no line", () => {
    assert.deepEqual(parseSourceRef("docs/ROADMAP.md"), { relPath: "docs/ROADMAP.md", line: null });
  });

  it("is not fooled by a colon in the path", () => {
    assert.deepEqual(parseSourceRef("content/odd:name.json"), { relPath: "content/odd:name.json", line: null });
  });

  it("has nothing to open for an empty or line-only reference", () => {
    for (const raw of ["", "   ", ":12"]) assert.equal(parseSourceRef(raw), null, raw);
  });

  it("treats line 0 as no line rather than as the first line", () => {
    assert.deepEqual(parseSourceRef("a/b.ts:0"), { relPath: "a/b.ts", line: null });
  });
});

describe("which paths may be opened", () => {
  it("opens a repository-relative source file", () => {
    assert.equal(refuseOpen("packages/engine-core/src/abilities.ts"), null);
  });

  it("refuses the licensed art, however the path is spelled", () => {
    for (const p of ["assets/x.glb", "assets/packs/a/b.png", "Assets/x.glb", "assets./x.glb", "assets /x.glb"]) {
      assert.match(refuseOpen(p) ?? "", /confidential licensed art/, p);
    }
  });

  it("refuses to leave the repository", () => {
    for (const p of ["../secrets.env", "a/../../b", "/etc/passwd", "C:/Windows/system32"]) {
      assert.ok(refuseOpen(p), p);
    }
  });

  it("refuses a Windows separator rather than guessing what it meant", () => {
    assert.match(refuseOpen("packages\\engine-core\\src\\a.ts") ?? "", /use \//);
  });

  it("names the path it refused, so the reason is actionable", () => {
    assert.match(refuseOpen("assets/x.glb") ?? "", /"assets\/x\.glb"/);
  });
});

describe("the two handoffs that need no host", () => {
  it("builds a vscode:// URI with the line and column", () => {
    // `file` is the URI's authority, so the absolute path follows it:
    // vscode://file/<abs>:<line>:<col>, which is what VS Code registers for.
    assert.equal(
      vscodeUri("/home/sam/engine", { relPath: "packages/a/b.ts", line: 51 }),
      "vscode://file/home/sam/engine/packages/a/b.ts:51:1",
    );
  });

  it("escapes a space in the path but keeps the line readable", () => {
    const uri = vscodeUri("/home/sam/my engine", { relPath: "a/b.ts", line: 7 });
    assert.ok(uri.includes("my%20engine"), uri);
    assert.ok(uri.endsWith(":7:1"), uri);
  });

  it("normalises a Windows repository root into the URI", () => {
    assert.equal(
      vscodeUri("C:\\dev\\engine", { relPath: "a/b.ts", line: 2 }),
      "vscode://file/C:/dev/engine/a/b.ts:2:1",
    );
  });

  it("copies a relative command, never the person's home directory", () => {
    assert.equal(codeCommand({ relPath: "packages/a/b.ts", line: 51 }), "code -g packages/a/b.ts:51");
    assert.equal(codeCommand({ relPath: "a/b.ts", line: null }), "code -g a/b.ts");
    assert.equal(codeCommand({ relPath: "a/my file.ts", line: 3 }), 'code -g "a/my file.ts:3"');
  });

  it("labels a chip with the file and line, not the whole path", () => {
    assert.equal(refLabel({ relPath: "packages/engine-core/src/abilities.ts", line: 51 }), "abilities.ts:51");
    assert.equal(refLabel({ relPath: "a/b.ts", line: null }), "b.ts");
  });
});

describe("the host route", () => {
  let root = "";
  let opened: string[][] = [];

  const deps = (found: boolean): CodeHostDeps => ({
    probe: async () => ({ command: "code", found, version: found ? "1.96.2" : null }),
    open: async (args) => {
      opened.push([...args]);
    },
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "code-host-"));
    mkdirSync(join(root, "packages", "engine-core", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "engine-core", "src", "abilities.ts"), "// ...\n");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "hero.glb"), "binary");
    opened = [];
    forgetEditorProbe();
  });

  const post = (body: unknown, found = true) =>
    handleCodeRoute(root, "POST", "/api/editor/code/open", JSON.stringify(body), deps(found));

  it("ignores every URL but its own", async () => {
    assert.equal(await handleCodeRoute(root, "GET", "/api/editor/scale", undefined, deps(true)), null);
  });

  it("reports the probe and the repository root", async () => {
    const reply = await handleCodeRoute(root, "GET", "/api/editor/code", undefined, deps(true));
    assert.equal(reply?.status, 200);
    assert.deepEqual((reply?.body as { editor: unknown }).editor, { command: "code", found: true, version: "1.96.2" });
  });

  it("probes once, however many rows ask", async () => {
    let probes = 0;
    const counting: CodeHostDeps = {
      probe: async () => {
        probes += 1;
        return { command: "code", found: true, version: "1.96.2" };
      },
      open: async () => undefined,
    };
    await handleCodeRoute(root, "GET", "/api/editor/code", undefined, counting);
    await handleCodeRoute(root, "GET", "/api/editor/code", undefined, counting);
    assert.equal(probes, 1);
  });

  it("opens a source location at its line", async () => {
    const reply = await post({ source: "packages/engine-core/src/abilities.ts:51" });
    assert.equal(reply?.status, 200);
    assert.deepEqual(opened, [["-g", `${join(root, "packages/engine-core/src/abilities.ts")}:51`]]);
  });

  it("takes the line as a field too, and prefers it", async () => {
    await post({ path: "packages/engine-core/src/abilities.ts", line: 9 });
    assert.ok(opened[0][1].endsWith(":9"), opened[0][1]);
  });

  it("starts nothing for the licensed art", async () => {
    const reply = await post({ source: "assets/hero.glb" });
    assert.equal(reply?.status, 400);
    assert.match(String((reply?.body as { error: string }).error), /confidential licensed art/);
    assert.deepEqual(opened, []);
  });

  it("starts nothing for a path that climbs out of the repository", async () => {
    for (const source of ["../outside.ts", "/etc/passwd"]) {
      const reply = await post({ source });
      assert.equal(reply?.status, 400, source);
    }
    assert.deepEqual(opened, []);
  });

  it("refuses a file this checkout does not have, rather than opening an empty buffer", async () => {
    const reply = await post({ source: "packages/engine-core/src/gone.ts:3" });
    assert.equal(reply?.status, 400);
    assert.match(String((reply?.body as { error: string }).error), /no such file/);
  });

  it("says what to do when `code` is not on PATH, and offers the command", async () => {
    const reply = await post({ source: "packages/engine-core/src/abilities.ts:51" }, false);
    assert.equal(reply?.status, 409);
    assert.match(String((reply?.body as { error: string }).error), /not found on this machine's PATH/);
    assert.equal((reply?.body as { command: string }).command, "code -g packages/engine-core/src/abilities.ts:51");
    assert.deepEqual(opened, []);
  });

  it("refuses a body it cannot read", async () => {
    assert.equal((await handleCodeRoute(root, "POST", "/api/editor/code/open", "{oops", deps(true)))?.status, 400);
    assert.equal((await post({}))?.status, 400);
    assert.equal(refFromBody({ path: 7 }), null);
  });

  it("passes an argv array, so a path can never become a command", () => {
    assert.deepEqual(codeArgs("/r/a b.ts", 4), ["-g", "/r/a b.ts:4"]);
    assert.deepEqual(codeArgs("/r/a.ts", null), ["/r/a.ts"]);
  });

  it("resolves inside the repository or explains why not", () => {
    const ok = resolveRef(root, { relPath: "packages/engine-core/src/abilities.ts", line: 1 });
    assert.ok("file" in ok && ok.file.startsWith(root));
    assert.ok("error" in resolveRef(root, { relPath: "assets/hero.glb", line: null }));
  });
});

describe("the button's own decisions", () => {
  it("skips the host when the host has already said `code` is missing", () => {
    assert.deepEqual(
      handoffSteps({ repoRoot: "/r", editor: { command: "code", found: false, version: null } }),
      ["uri", "copy"],
    );
  });

  it("tries the host first when `code` is there", () => {
    assert.deepEqual(
      handoffSteps({ repoRoot: "/r", editor: { command: "code", found: true, version: "1.96.2" } }),
      ["host", "uri", "copy"],
    );
  });

  it("still tries the host with no status, but cannot build a URI without the root", () => {
    assert.deepEqual(handoffSteps(null), ["host", "copy"]);
  });

  it("says where it will take you, or why it will not", () => {
    assert.match(chipTitle({ relPath: "a/b.ts", line: 51 }, null), /Open a\/b\.ts:51 in VS Code/);
    assert.equal(chipTitle({ relPath: "assets/x.glb", line: null }, "nope"), "nope");
  });
});

describe("the systems list carries each system's source", () => {
  const graph: EcsGraphPayload = {
    meta: { schemaVersion: 1, builtFromCommit: "abc1234", graphHash: "deadbeef" },
    currentHead: "abc1234",
    nodes: [
      { id: "component:Health", kind: "component", name: "Health" },
      {
        id: "system:abilities",
        kind: "system",
        name: "abilities",
        role: "simulation",
        declared: true,
        source: "packages/engine-core/src/abilities.ts:51",
      },
    ],
    edges: [
      {
        from: "system:abilities",
        to: "component:Health",
        kind: "writes",
        confidence: "declared",
        source: "packages/engine-core/src/abilities.ts:51",
      },
    ],
  } as unknown as EcsGraphPayload;

  it("puts the declaration site on the row", () => {
    const [row] = systemSignatures(indexEcsGraph(graph));
    assert.equal(row.source, "packages/engine-core/src/abilities.ts:51");
  });

  it("renders a chip that offers to open it", () => {
    const html = renderToStaticMarkup(
      React.createElement(ForgeSystemsView, {
        signatures: systemSignatures(indexEcsGraph(graph)),
        costs: null,
        codeStatus: { repoRoot: "/r", editor: { command: "code", found: true, version: "1.96.2" } },
      }),
    );
    assert.match(html, /abilities\.ts:51/);
    assert.match(html, /Open packages\/engine-core\/src\/abilities\.ts:51 in VS Code/);
  });
});
