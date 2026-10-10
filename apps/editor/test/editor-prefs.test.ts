/** editor-prefs: profiles, persisted preferences and sign out, over a fake (and a throwing) storage. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PREFS,
  currentProfile,
  listProfiles,
  loadPrefs,
  recallView,
  rememberView,
  resetPrefs,
  savePrefs,
  signOut,
  switchProfile,
  type PrefStorage,
} from "../src/ui/editor-prefs.js";

function memory(): PrefStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const broken: PrefStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("editor-prefs", () => {
  it("defaults, then round-trips saved prefs per profile", () => {
    const s = memory();
    assert.deepEqual(loadPrefs(s), DEFAULT_PREFS);
    savePrefs(s, { warnUnsaved: false, restoreLastView: true });
    assert.deepEqual(loadPrefs(s), { warnUnsaved: false, restoreLastView: true });
    switchProfile(s, "Level-Designer");
    assert.equal(currentProfile(s), "level-designer");
    assert.deepEqual(loadPrefs(s), DEFAULT_PREFS);
    switchProfile(s, "editor");
    assert.equal(loadPrefs(s).restoreLastView, true);
    resetPrefs(s);
    assert.deepEqual(loadPrefs(s), DEFAULT_PREFS);
  });

  it("ignores corrupt or wrongly typed entries", () => {
    const s = memory();
    s.setItem("mmo-editor.prefs.editor", "{not json");
    assert.deepEqual(loadPrefs(s), DEFAULT_PREFS);
    s.setItem("mmo-editor.prefs.editor", JSON.stringify({ warnUnsaved: "no", restoreLastView: true }));
    assert.deepEqual(loadPrefs(s), { warnUnsaved: true, restoreLastView: true });
  });

  it("lists profiles and refuses bad names", () => {
    const s = memory();
    switchProfile(s, "qa");
    switchProfile(s, "art");
    assert.deepEqual(listProfiles(s), ["art", "editor", "qa"]);
    assert.throws(() => switchProfile(s, "../x"), /profile name/);
    assert.throws(() => switchProfile(s, ""), /profile name/);
    assert.equal(currentProfile(s), "art");
  });

  it("sign out forgets the session but keeps profiles and prefs", () => {
    const s = memory();
    switchProfile(s, "qa");
    savePrefs(s, { warnUnsaved: false, restoreLastView: true });
    rememberView(s, "scenes", "scene");
    s.setItem("mmo-editor.play-last", "{}");
    assert.deepEqual(recallView(s), { workspace: "scenes", view: "scene" });
    signOut(s);
    assert.equal(currentProfile(s), "editor");
    assert.equal(recallView(s), null);
    assert.equal(s.getItem("mmo-editor.play-last"), null);
    assert.ok(listProfiles(s).includes("qa"));
    switchProfile(s, "qa");
    assert.equal(loadPrefs(s).warnUnsaved, false);
  });

  it("a blocked storage never throws", () => {
    assert.deepEqual(loadPrefs(broken), DEFAULT_PREFS);
    savePrefs(broken, DEFAULT_PREFS);
    signOut(broken);
    rememberView(broken, "a", "b");
    assert.equal(recallView(broken), null);
    assert.equal(currentProfile(null), "editor");
    assert.deepEqual(loadPrefs(null), DEFAULT_PREFS);
  });
});
