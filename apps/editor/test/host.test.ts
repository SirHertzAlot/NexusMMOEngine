/**
 * Editor host platform helpers: loopback-only guard for the art and
 * play-mode routes, npm resolution that can't pick up a foreign npm/Node,
 * and process-tree termination that works on Windows.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  isLoopbackAddress,
  killProcessTree,
  npmInvocation,
} from "../src/host.js";

describe("isLoopbackAddress", () => {
  it("accepts local connections", () => {
    for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) {
      assert.equal(isLoopbackAddress(a), true, a);
    }
  });
  it("rejects everything else", () => {
    for (const a of ["192.168.1.20", "10.0.0.5", "::ffff:192.168.1.20", "fe80::1", "", undefined]) {
      assert.equal(isLoopbackAddress(a), false, String(a));
    }
  });
});

describe("npmInvocation", () => {
  const args = ["run", "server", "--silent"];

  it("reuses the npm + Node that launched the editor, without a shell", () => {
    const inv = npmInvocation(
      args,
      { npm_execpath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" },
      "win32",
      "C:\\Program Files\\nodejs\\node.exe",
    );
    assert.deepEqual(inv, {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", ...args],
      shell: false,
    });
  });

  it("ignores a non-npm launcher (pnpm/yarn) and falls back", () => {
    const inv = npmInvocation(args, { npm_execpath: "/x/pnpm.cjs" }, "linux", "/usr/bin/node");
    assert.deepEqual(inv, { command: "npm", args, shell: false });
  });

  it("Windows fallback goes through npm.cmd in a shell", () => {
    const inv = npmInvocation(args, {}, "win32", "node.exe");
    assert.deepEqual(inv, {
      command: "npm.cmd run server --silent",
      args: [],
      shell: true,
    });
  });
});

describe("killProcessTree", () => {
  it("terminates a spawned child tree on this platform", async () => {
    // A child that would otherwise live for a minute.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    await new Promise((r) => setTimeout(r, 200));
    killProcessTree(child.pid!, "SIGKILL");
    await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("child survived killProcessTree")), 10_000),
      ),
    ]);
  });

  it("is a no-op for invalid pids", () => {
    killProcessTree(-1, "SIGTERM");
    killProcessTree(0, "SIGTERM");
  });
});
