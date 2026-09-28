/**
 * Reboot test (slice 1.4): real SIGTERM through a child process.
 *
 * 1. Boot a child server, let it tick past 400, SIGTERM it. The
 *    shutdown hook must save and the child must exit 0.
 * 2. Read the saved snapshot straight from the DB (pre-kill state).
 * 3. Boot a second child from that snapshot: it must resume at the
 *    saved tick with a bit-identical world (entity count + sampled
 *    transforms compared exactly).
 * 4. The rebooted child ticks 10 more; a third child runs
 *    uninterrupted to the same tick — the two states must match
 *    exactly, proving simulation continues correctly after restore.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SnapshotStore,
  decodeSnapshot,
  stateFromCollected,
  compareStates,
} from "../../src/index.js";

const CHILD = fileURLToPath(new URL("./reboot-child.js", import.meta.url));
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function spawnChild(
  mode: string,
  args: string[],
): { child: ChildProcess; stderr: () => string } {
  const child = spawn(process.execPath, [CHILD, mode, ...args], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr?.on("data", (d: Buffer) => {
    err += d.toString();
  });
  return { child, stderr: () => err };
}

async function waitForTickFile(
  dir: string,
  minTick: number,
  timeoutMs: number,
): Promise<number> {
  const file = path.join(dir, "tick.txt");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const t = Number(fs.readFileSync(file, "utf8"));
      if (t >= minTick) return t;
    } catch {
      // not written yet
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for tick >= ${minTick}`);
    }
    await sleep(100);
  }
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for child exit"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function readJson(dir: string, name: string): { tick: number; entityCount: number } {
  return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
}

test(
  "SIGTERM save + reboot restores exact state and resumes ticking",
  {
    timeout: 120_000,
    // Node cannot deliver SIGTERM on Windows: child.kill("SIGTERM") is a
    // hard TerminateProcess, so no handler runs. (Ctrl+C in a console
    // does raise SIGINT there, which the same shutdown hook handles.)
    skip: process.platform === "win32" ? "no catchable SIGTERM on Windows" : false,
  },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-reboot-"));
    const dbPath = path.join(dir, "world.db");
    let child: ChildProcess | undefined;
    let childStderr = (): string => "";
    try {
      // 1. Run to tick ~400, then SIGTERM. The shutdown hook saves.
      ({ child, stderr: childStderr } = spawnChild("run", [dbPath, dir]));
      await waitForTickFile(dir, 400, 30_000);
      child.kill("SIGTERM");
      const code = await waitForExit(child, 15_000);
      child = undefined;
      assert.equal(
        code,
        0,
        `run child must exit 0 after SIGTERM save (stderr: ${childStderr()})`,
      );

      // 2. Pre-kill state, straight from the DB the hook wrote.
      const store = new SnapshotStore({ dbPath });
      const saved = store.loadLatest();
      assert.ok(saved, "shutdown hook saved a snapshot");
      assert.ok(saved.tick >= 400, `saved at tick ${saved.tick}, want >= 400`);
      const preState = stateFromCollected(decodeSnapshot(saved.bytes));
      const preCount = saved.entityCount;
      store.close();

      // 3. Boot from the snapshot: exact tick, exact state.
      ({ child, stderr: childStderr } = spawnChild("boot", [dbPath, dir]));
      const bootCode = await waitForExit(child, 60_000);
      child = undefined;
      assert.equal(
        bootCode,
        0,
        `boot child must exit 0 (stderr: ${childStderr()})`,
      );
      const after = readJson(dir, "after");
      assert.equal(after.tick, saved.tick, "boot resumes at the saved tick");
      assert.equal(
        after.entityCount,
        preCount,
        "entity count survives the reboot",
      );
      const afterState = stateFromCollected(
        decodeSnapshot(new Uint8Array(fs.readFileSync(path.join(dir, "after.bin")))),
      );
      const cmp = compareStates(preState, afterState);
      assert.ok(
        cmp.equal,
        `restored state differs from saved state: ${cmp.diffs.join("; ")}`,
      );

      // 4. Rebooted + 10 ticks == uninterrupted run to the same tick.
      const continued = readJson(dir, "continued");
      assert.equal(continued.tick, saved.tick + 10);
      ({ child, stderr: childStderr } = spawnChild("reference", [
        dir,
        String(saved.tick + 10),
      ]));
      const refCode = await waitForExit(child, 60_000);
      child = undefined;
      assert.equal(
        refCode,
        0,
        `reference child must exit 0 (stderr: ${childStderr()})`,
      );
      const continuedState = stateFromCollected(
        decodeSnapshot(
          new Uint8Array(fs.readFileSync(path.join(dir, "continued.bin"))),
        ),
      );
      const refState = stateFromCollected(
        decodeSnapshot(
          new Uint8Array(fs.readFileSync(path.join(dir, "reference.bin"))),
        ),
      );
      const cmp2 = compareStates(continuedState, refState);
      assert.ok(
        cmp2.equal,
        `continued state differs from uninterrupted run: ${cmp2.diffs.join("; ")}`,
      );

      console.log(
        `reboot ok: hook saved tick ${saved.tick} (${preCount} entities), ` +
          `restore bit-identical, continuation matches uninterrupted run`,
      );
    } finally {
      child?.kill("SIGKILL");
    }
  },
);
