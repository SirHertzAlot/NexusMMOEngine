/**
 * The editor's layers (docs/EDITOR.md, "How the editor is layered",
 * roadmap EB11).
 *
 * The seam was already there — hosts validate and write, clients carry
 * one route family, stores hold shared state, views draw — but nothing
 * said so and nothing checked, and it has been broken by accident twice
 * in one phase: reading the play state pulled `@mmo-engine/client/render`
 * in behind it, which is why `playUiStore` and `getPlayController` had to
 * be lifted out of `ui/play-mode.tsx` before a panel could be tested at
 * all.
 *
 * So this file is the guard, and it is deliberately a source test rather
 * than a lint rule: the facts it checks are about which file imports
 * what, which is cheaper to read from the text than to configure.
 *
 * The one list of exceptions can only shrink. A name in it that no
 * longer fetches fails the test, so fixing a panel forces the list to be
 * updated, and the list cannot quietly become fiction.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const UI = join(SRC, "ui");

const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");
const list = (dir: string, match: (name: string) => boolean): string[] =>
  readdirSync(dir).filter(match).sort();

const views = (): string[] => list(UI, (f) => f.endsWith(".tsx"));
const stores = (): string[] => [...list(UI, (f) => f.endsWith("-store.ts")), "../store.ts"];
const clients = (): string[] => list(SRC, (f) => f.endsWith("-client.ts"));
const hosts = (): string[] => list(SRC, (f) => f.endsWith("-host.ts"));

/**
 * Panels that still do their own fetching. Each one is a panel that
 * predates its route having a client, not a decision. The list may only
 * shrink: give the route a `*-client.ts` and delete the name.
 */
const VIEWS_THAT_STILL_FETCH: readonly string[] = [
  "asset-inspector.tsx", // GET /api/editor/assets — the art scan
  "asset-preview.tsx", // GET /api/editor/assets/resolve
  "dock-details.tsx", // GET /api/editor/build/profiles
  "network-live.tsx", // GET/PUT /api/editor/network
  "pipeline-view.tsx", // DELETE /api/editor/build/profiles/:name
  "play-mode.tsx", // POST /api/editor/play/client
  "selection-card.tsx", // GET /api/editor/pcg/library
];

/** `fetch(` in code, ignoring the ones inside a comment or a string of prose. */
const callsFetch = (source: string): boolean => /(^|[^.\w])fetch\s*\(/m.test(stripComments(source));

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Value imports only: `import type { X } from "y"` is erased at build. */
function valueImports(source: string): string[] {
  const out: string[] = [];
  const re = /^import\s+(?!type\s)([\s\S]*?)from\s+"([^"]+)"/gm;
  for (const m of stripComments(source).matchAll(re)) {
    // `import { type A, type B } from` is also erased.
    const clause = m[1];
    const onlyTypes = /^\s*\{[^}]*\}\s*$/.test(clause) && !/\{[^}]*(?<!type\s)[A-Za-z_$][\w$]*\s*(,|\})/.test(clause.replace(/type\s+[\w$]+/g, ""));
    if (!onlyTypes) out.push(m[2]);
  }
  return out;
}

describe("a view draws; it does not fetch", () => {
  it("names every panel that still does its own fetching", () => {
    const fetching = views().filter((f) => callsFetch(read(UI, f)));
    assert.deepEqual(
      fetching,
      [...VIEWS_THAT_STILL_FETCH].sort(),
      "a panel started fetching, or one on the list stopped — a new one needs a *-client.ts; a fixed one comes off the list",
    );
  });

  it("keeps the exception list honest", () => {
    // Every name on the list is a real file. A panel that was renamed or
    // deleted must not leave a name behind to excuse a future panel.
    for (const f of VIEWS_THAT_STILL_FETCH) {
      assert.ok(views().includes(f), `${f} is on the fetch list but is not a panel any more`);
    }
  });
});

describe("a model holds state; it does not render", () => {
  it("imports no renderer", () => {
    for (const f of stores()) {
      const dir = f.startsWith("..") ? SRC : UI;
      const name = f.startsWith("..") ? f.slice(3) : f;
      for (const spec of valueImports(read(dir, name))) {
        assert.ok(
          !/^three|@mmo-engine\/client/.test(spec),
          `${f} imports ${spec}: a store that pulls a renderer in cannot be read without one`,
        );
      }
    }
  });
});

describe("a host runs in node; a view runs in the browser", () => {
  it("no host imports React", () => {
    for (const f of hosts()) {
      assert.ok(!/from "react"/.test(read(SRC, f)), `${f} imports React`);
    }
  });

  it("no view imports a host's code, only its types", () => {
    for (const f of views()) {
      for (const spec of valueImports(read(UI, f))) {
        assert.ok(!/-host\.js$/.test(spec), `${f} imports ${spec} as a value: node code cannot run in the browser`);
      }
    }
  });

  it("no client talks to more than its own host", () => {
    // One client per route family is what keeps a refusal turning back
    // into one document's error type.
    for (const f of clients()) {
      const paths = [...read(SRC, f).matchAll(/"\/api\/editor\/([a-z-]+)/g)].map((m) => m[1]);
      const families = new Set(paths);
      assert.ok(families.size <= 2, `${f} reaches ${[...families].join(", ")}: split it, or move the odd route`);
    }
  });
});
