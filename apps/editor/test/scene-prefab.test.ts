/**
 * Making a prefab from a scene selection, and reading an instance back
 * (roadmap EB3).
 *
 * The rules are the scene package's (`prefabFromNodes`,
 * `prefabAuthorProblems`, `instanceOverrides`) and the writing is the
 * prefabs data table, which validates with the engine's own
 * `validatePrefab`. So what is worth holding here is the join: the table
 * payload keeps the prefabs that were already there, the form refuses what
 * the host would refuse, and an instance's own fields are shown as the
 * instance's rather than as the prefab's.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { prefabFromNodes, type PrefabDoc, type SceneDoc } from "@mmo-engine/scene";
import { instanceSummary, overrideLabel, prefabNames, prefabOf, prefabTableContent, prefabRows, suggestPrefabName } from "../src/scene-prefab.js";
import { MakePrefabDialog, PrefabInstanceCard } from "../src/ui/make-prefab-dialog.js";

const camp: PrefabDoc = {
  version: 1,
  name: "goblin-camp",
  components: { Spawner: { creature: "goblin", respawnSeconds: 90 } },
  children: [{ id: "lookout", transform: { position: [6, 0, 2] } }],
};

/** The prefabs table as a gameplay snapshot carries it: rows without version or name. */
const table = { prefabs: { "goblin-camp": { components: camp.components, children: camp.children } } };

const scene = (): SceneDoc => ({
  version: 1,
  name: "world",
  kind: "world",
  nodes: [
    { id: "fire", name: "Camp fire", kind: "group", transform: { position: [10, 0, 4] } },
    { id: "tent-2", kind: "group", transform: { position: [14, 0, 4] } },
  ],
});

describe("the prefabs table", () => {
  it("reads rows and names out of a snapshot, and is not upset by a missing one", () => {
    assert.deepEqual(prefabNames(table), ["goblin-camp"]);
    assert.deepEqual(prefabNames(null), []);
    assert.deepEqual(prefabRows({ prefabs: 7 }), {});
  });

  it("finds a prefab by the reference a node carries, whole or by its last segment", () => {
    assert.equal(prefabOf(table, "goblin-camp")?.name, "goblin-camp");
    assert.equal(prefabOf(table, "camps/goblin-camp")?.name, "goblin-camp", "the server's spawner resolves it the same way");
    assert.equal(prefabOf(table, "nothing"), undefined);
    assert.equal(prefabOf(table, undefined), undefined);
  });

  it("keeps the prefabs that were already there when one is added", () => {
    const { prefab } = prefabFromNodes(scene(), ["fire", "tent-2"], "watch-post");
    const content = prefabTableContent(table, prefab);
    assert.deepEqual(Object.keys(content.prefabs).sort(), ["goblin-camp", "watch-post"]);
    assert.equal("version" in content.prefabs["watch-post"], false, "the table holds rows, not documents");
    assert.equal("name" in content.prefabs["watch-post"], false);
    assert.deepEqual(content.prefabs["goblin-camp"], table.prefabs["goblin-camp"]);
  });

  it("replaces one of the same name rather than making a second", () => {
    const content = prefabTableContent(table, { version: 1, name: "goblin-camp", children: [] });
    assert.deepEqual(Object.keys(content.prefabs), ["goblin-camp"]);
    assert.deepEqual(content.prefabs["goblin-camp"], { children: [] });
  });
});

describe("the suggested name", () => {
  it("comes from what is selected, as a name a prefab may have", () => {
    assert.equal(suggestPrefabName([{ id: "x", name: "Camp fire" }]), "camp-fire");
    assert.equal(suggestPrefabName([{ id: "tent-2" }]), "tent", "the copy number is not part of the thing");
    assert.equal(suggestPrefabName([{ id: "???" }]), "prefab");
    assert.equal(suggestPrefabName([]), "prefab");
  });

  it("steps past a name already in use", () => {
    assert.equal(suggestPrefabName([{ id: "goblin-camp" }], ["goblin-camp"]), "goblin-camp-2");
    assert.equal(suggestPrefabName([{ id: "goblin-camp" }], ["goblin-camp", "goblin-camp-2"]), "goblin-camp-3");
  });
});

describe("what an instance says differently", () => {
  it("puts the prefab's own value beside the instance's", () => {
    assert.equal(
      overrideLabel({ component: "Spawner", field: "respawnSeconds", value: 20, base: 90, added: false }),
      "Spawner.respawnSeconds = 20 (the prefab says 90)",
    );
    assert.equal(
      overrideLabel({ component: "ItemSpawn", field: "base", value: "torch", added: true }),
      'ItemSpawn.base = torch (the prefab has no ItemSpawn)',
    );
    assert.match(overrideLabel({ component: "Spawner", field: "species", value: "wolf", added: false }), /leaves it to the default/);
  });

  it("summarises the instance in one line", () => {
    const node = { id: "c-1", prefab: "goblin-camp", components: { Spawner: { respawnSeconds: 20 } } };
    assert.equal(instanceSummary(node, camp), "goblin-camp: 1 child, 1 override on this instance.");
    assert.equal(instanceSummary({ id: "c-1", prefab: "goblin-camp" }, camp), "goblin-camp: 1 child, nothing overridden here.");
    assert.match(instanceSummary({ id: "c-1", prefab: "ghost" }, undefined), /No prefab called "ghost"/);
  });
});

describe("the Make prefab form", () => {
  const render = (props: Partial<React.ComponentProps<typeof MakePrefabDialog>> = {}): string =>
    renderToStaticMarkup(
      React.createElement(MakePrefabDialog, {
        open: true,
        doc: scene(),
        ids: ["fire", "tent-2"],
        existing: ["goblin-camp"],
        onCancel: () => {},
        onMake: () => {},
        ...props,
      }),
    );

  it("says what goes in, where the origin lands, and what gets written", () => {
    const html = render();
    assert.match(html, /2 nodes go in/);
    assert.match(html, /fire, tent-2/);
    assert.match(html, /origin is 12, 0, 4/, "the middle of the spread, at the lowest node");
    assert.match(html, /content\/prefabs\/camp-fire\.prefab\.json/, "named from the selection");
    assert.match(html, /Undo takes/, "and that undo does not take the file back");
  });

  it("draws nothing when it is closed", () => {
    assert.equal(render({ open: false }), "");
  });

  it("shows the host's refusal when there is one", () => {
    assert.match(render({ issues: [{ path: "name", message: '"goblin-camp" is a creature' }] }), /is a creature/);
  });
});

describe("the instance card", () => {
  const render = (node: { id: string; prefab?: string; components?: Record<string, Record<string, unknown>> }, prefab?: PrefabDoc): string =>
    renderToStaticMarkup(React.createElement(PrefabInstanceCard, { node, prefab, onRevert: () => {} }));

  it("lists each override with its own Revert", () => {
    const html = render({ id: "c-1", prefab: "goblin-camp", components: { Spawner: { respawnSeconds: 20 } } }, camp);
    assert.match(html, /1 overridden/);
    assert.match(html, /the prefab says 90/);
    assert.match(html, /prefab-revert-Spawner-respawnSeconds/);
  });

  it("says so when the reference names no prefab", () => {
    const html = render({ id: "c-1", prefab: "ghost" });
    assert.match(html, /no such prefab/);
    assert.equal(/prefab-revert-/.test(html), false);
  });

  it("has nothing to revert on an instance that changes nothing", () => {
    const html = render({ id: "c-1", prefab: "goblin-camp" }, camp);
    assert.equal(/\d+ overridden/.test(html), false, "no badge, since there is no override");
    assert.equal(/prefab-revert-/.test(html), false);
    assert.match(html, /nothing overridden here/);
  });
});
