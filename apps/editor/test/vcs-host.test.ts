/**
 * VCS host: runs against throwaway git repos created here, never the real
 * repo. Covers status/diff/stage/commit, the /assets/ refusal, push/pull
 * behind confirm, id-keyed merge resolution and soft locks.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleVcsRoute } from "../src/vcs-host.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "mmo-vcs-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "core.autocrlf", "false");
  mkdirSync(join(root, "content", "scenes"), { recursive: true });
  return root;
}
const put = (root: string, rel: string, v: unknown): void => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), typeof v === "string" ? v : `${JSON.stringify(v, null, 2)}\n`);
};
// One line, so any two edits conflict textually in git.
const putc = (root: string, rel: string, v: unknown): void => put(root, rel, `${JSON.stringify(v)}\n`);
const call = (root: string, method: string, path: string, body?: unknown) =>
  handleVcsRoute(root, method, `/api/editor/vcs${path}`, body === undefined ? undefined : JSON.stringify(body));
const SCENE = "content/scenes/a.scene.json";
const scene = (nodes: unknown[]) => ({ version: 1, name: "a", kind: "arena", modules: ["core"], nodes });

describe("vcs route", () => {
  it("ignores other paths", async () => assert.equal(await handleVcsRoute(initRepo(), "GET", "/api/editor/scenes", undefined), null));

  it("edit a scene, see a semantic diff, commit from the editor", async () => {
    const root = initRepo();
    put(root, SCENE, scene([{ id: "spawn", name: "S" }, { id: "camp", name: "Camp" }]));
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    put(root, SCENE, scene([{ id: "spawn", name: "S" }, { id: "camp", name: "Camp 2" }, { id: "chest" }]));

    const st = (await call(root, "GET", "/status"))!;
    const body = st.body as { branch: string; files: Array<{ path: string; docType: string; status: string }> };
    assert.equal(st.status, 200);
    assert.equal(body.branch, "main");
    assert.deepEqual(body.files.map((f) => [f.path, f.docType, f.status]), [[SCENE, "scene", "modified"]]);

    const d = (await call(root, "GET", `/diff?path=${encodeURIComponent(SCENE)}`))!.body as { mode: string; summary: string[] };
    assert.equal(d.mode, "semantic");
    assert.deepEqual(d.summary, ['nodes[camp].name: "Camp" -> "Camp 2"', 'nodes[chest]: added {"id":"chest"}']);

    assert.equal((await call(root, "POST", "/stage", { paths: [SCENE] }))!.status, 200);
    const c = (await call(root, "POST", "/commit", { message: "move camp" }))!;
    assert.equal(c.status, 200);
    const log = (await call(root, "GET", "/log"))!.body as { commits: Array<{ subject: string }> };
    assert.equal(log.commits[0].subject, "move camp");
    assert.deepEqual(((await call(root, "GET", "/status"))!.body as { files: unknown[] }).files, []);
  });

  it("refuses to commit without a message or without staged changes", async () => {
    const root = initRepo();
    put(root, "README.md", "x");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "i");
    assert.equal((await call(root, "POST", "/commit", { message: "  " }))!.status, 400);
    assert.equal((await call(root, "POST", "/commit", { message: "m" }))!.status, 400);
  });

  it("refuses to stage anything under assets/, however it is spelled", async () => {
    const root = initRepo();
    put(root, "assets/art/x.txt", "secret");
    put(root, "content/ok.json", {});
    for (const p of ["assets/art/x.txt", "./assets/art/x.txt", "Assets/art/x.txt", "assets", "content/../assets/art/x.txt", "assets\\art\\x.txt", "."]) {
      const r = (await call(root, "POST", "/stage", { paths: ["content/ok.json", p] }))!;
      assert.equal(r.status, 400, p);
    }
    assert.equal(git(root, "diff", "--cached", "--name-only").trim(), "", "nothing staged, even the allowed sibling");
    assert.match(((await call(root, "POST", "/stage", { paths: ["assets/art/x.txt"] }))!.body as { error: string }).error, /assets/);
    assert.equal((await call(root, "GET", "/diff?path=assets/art/x.txt"))!.status, 400);
    const files = ((await call(root, "GET", "/status"))!.body as { files: Array<{ path: string; localOnly?: boolean }> }).files;
    assert.ok(files.find((f) => f.path.startsWith("assets/"))?.localOnly);
  });

  it("refuses to commit when assets/ is already in the index (staged outside the editor)", async () => {
    const root = initRepo();
    put(root, "assets/a.txt", "s");
    git(root, "add", "-f", "assets/a.txt");
    const r = (await call(root, "POST", "/commit", { message: "oops" }))!;
    assert.equal(r.status, 400);
    assert.match((r.body as { error: string }).error, /assets/);
  });

  it("rejects path escapes and pathspec magic", async () => {
    const root = initRepo();
    for (const p of ["../x", ":(glob)**", "/etc/passwd", "C:\\x", ""]) {
      assert.equal((await call(root, "POST", "/stage", { paths: [p] }))!.status, 400, p);
    }
  });

  it("push and pull need confirm and move commits through a remote", async () => {
    const remote = mkdtempSync(join(tmpdir(), "mmo-vcs-remote-"));
    git(remote, "init", "-q", "--bare", "-b", "main");
    const a = initRepo();
    put(a, "content/x.json", { v: 1 });
    git(a, "add", "-A");
    git(a, "commit", "-qm", "one");
    git(a, "remote", "add", "origin", remote);
    assert.equal((await call(a, "POST", "/push", {}))!.status, 400);
    const p = (await call(a, "POST", "/push", { confirm: true }))!;
    assert.equal(p.status, 200, JSON.stringify(p.body));

    const b = mkdtempSync(join(tmpdir(), "mmo-vcs-b-"));
    git(b, "clone", "-q", remote, ".");
    git(b, "config", "user.email", "b@example.com");
    git(b, "config", "user.name", "B");
    put(b, "content/y.json", { v: 2 });
    git(b, "add", "-A");
    git(b, "commit", "-qm", "two");
    git(b, "push", "-q", "origin", "main");

    assert.equal((await call(a, "POST", "/pull", {}))!.status, 400);
    const pull = (await call(a, "POST", "/pull", { confirm: true }))!;
    assert.equal(pull.status, 200, JSON.stringify(pull.body));
    assert.equal(JSON.parse(readFileSync(join(a, "content/y.json"), "utf8")).v, 2);
  });

  it("a conflicting pull of two scene edits resolves by node id", async () => {
    const remote = mkdtempSync(join(tmpdir(), "mmo-vcs-remote-"));
    git(remote, "init", "-q", "--bare", "-b", "main");
    const a = initRepo();
    putc(a, SCENE, scene([{ id: "spawn", name: "S" }, { id: "camp", name: "Camp" }]));
    git(a, "add", "-A");
    git(a, "commit", "-qm", "base");
    git(a, "remote", "add", "origin", remote);
    git(a, "push", "-q", "origin", "main");
    const b = mkdtempSync(join(tmpdir(), "mmo-vcs-b-"));
    git(b, "clone", "-q", remote, ".");
    git(b, "config", "user.email", "b@example.com");
    git(b, "config", "user.name", "B");
    // B renames the spawn node and pushes.
    putc(b, SCENE, scene([{ id: "spawn", name: "Start" }, { id: "camp", name: "Camp" }]));
    git(b, "commit", "-qam", "b edit");
    git(b, "push", "-q", "origin", "main");
    // A (same lines in the text diff) renames the camp and adds a node.
    putc(a, SCENE, scene([{ id: "spawn", name: "S" }, { id: "camp", name: "Camp A" }, { id: "chest" }]));
    git(a, "commit", "-qam", "a edit");

    const pull = (await call(a, "POST", "/pull", { confirm: true }))!;
    assert.equal(pull.status, 409, JSON.stringify(pull.body));
    const conflicted = (pull.body as { conflicts: string[] }).conflicts;
    assert.deepEqual(conflicted, [SCENE]);

    const res = (await call(a, "POST", "/resolve", { path: SCENE }))!;
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((res.body as { resolved: boolean }).resolved, true);
    const merged = JSON.parse(readFileSync(join(a, SCENE), "utf8")) as { nodes: Array<{ id: string; name?: string }> };
    assert.deepEqual(merged.nodes.map((n) => [n.id, n.name]), [["spawn", "Start"], ["camp", "Camp A"], ["chest", undefined]]);
    assert.equal((await call(a, "POST", "/commit", { message: "merge" }))!.status, 200);
    assert.equal(git(a, "status", "--porcelain").trim(), "");
  });

  it("a true conflict is reported with both values and writes nothing", async () => {
    const remote = mkdtempSync(join(tmpdir(), "mmo-vcs-remote-"));
    git(remote, "init", "-q", "--bare", "-b", "main");
    const a = initRepo();
    putc(a, SCENE, scene([{ id: "camp", name: "Camp" }]));
    git(a, "add", "-A");
    git(a, "commit", "-qm", "base");
    git(a, "remote", "add", "origin", remote);
    git(a, "push", "-q", "origin", "main");
    const b = mkdtempSync(join(tmpdir(), "mmo-vcs-b-"));
    git(b, "clone", "-q", remote, ".");
    git(b, "config", "user.email", "b@example.com");
    git(b, "config", "user.name", "B");
    putc(b, SCENE, scene([{ id: "camp", name: "B name" }]));
    git(b, "commit", "-qam", "b");
    git(b, "push", "-q", "origin", "main");
    putc(a, SCENE, scene([{ id: "camp", name: "A name" }]));
    git(a, "commit", "-qam", "a");
    await call(a, "POST", "/pull", { confirm: true });
    const res = (await call(a, "POST", "/resolve", { path: SCENE }))!;
    const body = res.body as { resolved: boolean; conflicts: Array<{ path: string; ours: unknown; theirs: unknown }> };
    assert.equal(res.status, 200);
    assert.equal(body.resolved, false);
    assert.deepEqual([body.conflicts[0].path, body.conflicts[0].ours, body.conflicts[0].theirs], ["nodes[camp].name", "A name", "B name"]);
    // choosing a side resolves it
    const pick = (await call(a, "POST", "/resolve", { path: SCENE, choices: { "nodes[camp].name": "theirs" } }))!;
    assert.equal((pick.body as { resolved: boolean }).resolved, true);
    assert.equal(JSON.parse(readFileSync(join(a, SCENE), "utf8")).nodes[0].name, "B name");
  });
});

describe("soft locks", () => {
  it("take, conflict with another owner, release", async () => {
    const root = initRepo();
    const r1 = (await call(root, "POST", "/lock", { document: SCENE, owner: "ana" }))!;
    assert.equal(r1.status, 200);
    assert.equal((await call(root, "POST", "/lock", { document: SCENE, owner: "bo" }))!.status, 409);
    assert.equal((await call(root, "POST", "/lock", { document: SCENE, owner: "ana" }))!.status, 200);
    const list = (await call(root, "GET", "/locks"))!.body as { locks: Record<string, { owner: string }> };
    assert.equal(list.locks[SCENE].owner, "ana");
    assert.equal(JSON.parse(readFileSync(join(root, "content/locks.json"), "utf8")).locks[SCENE].owner, "ana");
    assert.equal((await call(root, "POST", "/unlock", { document: SCENE, owner: "bo" }))!.status, 409);
    assert.equal((await call(root, "POST", "/unlock", { document: SCENE, owner: "ana" }))!.status, 200);
    assert.deepEqual(((await call(root, "GET", "/locks"))!.body as { locks: object }).locks, {});
  });
  it("locks only documents under content/", async () => {
    const root = initRepo();
    assert.equal((await call(root, "POST", "/lock", { document: "assets/x", owner: "a" }))!.status, 400);
    assert.equal((await call(root, "POST", "/lock", { document: "../x", owner: "a" }))!.status, 400);
  });
});
