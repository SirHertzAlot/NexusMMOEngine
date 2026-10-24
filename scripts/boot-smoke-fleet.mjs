#!/usr/bin/env node
/**
 * Fleet boot smoke — the standalone boot smoke (scripts/boot-smoke.mjs)
 * plus the fleet tier: a real SurrealDB, the real world server on top of
 * it, and a region that registers with the world (WORLD_URL set) before
 * serving the same hello → welcome → snapshot → delta handshake.
 *
 * Prereqs: same as boot-smoke.mjs, plus a SurrealDB 2.x binary —
 * `SURREAL_BIN=/path/to/surreal` or `surreal` on PATH.
 *
 * Ports: SurrealDB 8001, world HTTP 7780 (WORLD_PORT), region 7917
 * (BOOT_SMOKE_PORT). Scratch state lives in .boot-smoke-fleet/ and is
 * removed on success unless BOOT_SMOKE_KEEP=1.
 *
 * Exit 0 = every stage passed; the [fleet-smoke] lines are the evidence.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineDist = path.join(root, "packages", "engine-core", "dist");
const worldEntry = path.join(root, "packages", "world-server", "dist", "src", "server.js");
const serverEntry = path.join(engineDist, "src", "server.js");
const seedEntry = path.join(engineDist, "src", "auth", "seed-user.js");
const SURREAL_PORT = 8001;
const WORLD_PORT = 7780;
const REGION_PORT = Number(process.env.BOOT_SMOKE_PORT ?? 7917);
const API_KEY = "boot-smoke-key";
const USER = "smoke";
const PASSWORD = "smoke-password-1";

const say = (m) => console.log(`[fleet-smoke] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = null;
const fail = (stage, why) => { failed = `${stage}: ${why}`; throw new Error(failed); };

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => { s.end(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}
function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${out}`))));
  });
}

async function main() {
  const surrealBin = process.env.SURREAL_BIN ?? "surreal";
  if (!fs.existsSync(worldEntry) || !fs.existsSync(serverEntry)) fail("prereq", "dist missing — build world-server and engine-core first");
  for (const p of [SURREAL_PORT, WORLD_PORT, REGION_PORT]) if (!(await portFree(p))) fail("prereq", `port ${p} already in use`);

  const scratch = path.join(root, ".boot-smoke-fleet");
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(path.join(scratch, "data"), { recursive: true });
  const children = [];
  const startLogged = (name, cmd, args, env) => {
    const stream = fs.createWriteStream(path.join(scratch, `${name}.log`));
    const p = spawn(cmd, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    p.stdout.on("data", (d) => { text += d; stream.write(d); });
    p.stderr.on("data", (d) => { text += d; stream.write(d); });
    const handle = { proc: p, exit: null, text: () => text };
    p.on("exit", (code, signal) => { handle.exit = { code, signal }; });
    children.push(handle);
    return handle;
  };
  const waitFor = async (what, cond, timeoutMs, tailFrom) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (cond()) return Date.now() - t0;
      await sleep(100);
    }
    fail(what, `timed out after ${timeoutMs} ms; log tail:\n${tailFrom().split("\n").slice(-15).join("\n")}`);
  };
  const stop = async (handle, name) => {
    if (handle.exit) { say(`${name}: already exited ${JSON.stringify(handle.exit)}`); return; }
    handle.proc.kill("SIGTERM");
    const t0 = Date.now();
    while (!handle.exit && Date.now() - t0 < 30_000) await sleep(100);
    if (!handle.exit) { handle.proc.kill("SIGKILL"); fail("shutdown", `${name} did not exit within 30s of SIGTERM`); }
    say(`${name}: SIGTERM exit code=${handle.exit.code} signal=${handle.exit.signal} after ${Date.now() - t0} ms`);
  };

  try {
    // 1. SurrealDB on 8001, scratch rocksdb inside the worktree scratch dir.
    const surreal = startLogged("surreal", surrealBin, [
      "start", "--user", "root", "--pass", "root", "--bind", `127.0.0.1:${SURREAL_PORT}`,
      `rocksdb:${path.join(scratch, "surrealdb")}`,
    ], { ...process.env });
    {
      const t0 = Date.now();
      while (!(await portOpen(SURREAL_PORT))) {
        if (surreal.exit) fail("surreal", `exited early ${JSON.stringify(surreal.exit)}:\n${surreal.text().split("\n").slice(-10).join("\n")}`);
        if (Date.now() - t0 > 60_000) fail("surreal", "port 8001 never opened");
        await sleep(100);
      }
      say(`surrealdb: port ${SURREAL_PORT} open after ${Date.now() - t0} ms`);
    }

    // 2. World server over the real Surreal store.
    const world = startLogged("world", process.execPath, [worldEntry], {
      ...process.env,
      WORLD_PORT: String(WORLD_PORT),
      WORLD_DB_URL: `ws://127.0.0.1:${SURREAL_PORT}/rpc`,
      WORLD_DB_USER: "root",
      WORLD_DB_PASS: "root",
      WORLD_API_KEY: API_KEY,
    });
    await waitFor("world", () => world.text().includes("[world] listening on"), 60_000, world.text);
    say(`world: ${world.text().match(/\[world\] store=.*/)?.[0] ?? "store line not seen"}`);
    say(`world: ${world.text().match(/\[world\] listening on .*/) [0]}`);

    // 3. Region in fleet mode: seed its user, boot with WORLD_URL.
    const dataDir = path.join(scratch, "data");
    const seedOut = await run(process.execPath, [seedEntry, "--csv", path.join(dataDir, "users.csv"), USER], {
      ...process.env, MMO_DEV_PASSWORD: PASSWORD,
    }).catch((e) => fail("seed-user", e.message));
    say(`seed-user: ${seedOut.trim()}`);
    const t0 = Date.now();
    const region = startLogged("region", process.execPath, [serverEntry], {
      ...process.env,
      MMO_DATA_DIR: dataDir,
      MMO_PORT: String(REGION_PORT),
      WORLD_URL: `http://127.0.0.1:${WORLD_PORT}`,
      WORLD_API_KEY: API_KEY,
    });
    await waitFor("region-register", () => region.text().includes("registered with world"), 120_000, region.text);
    say(`region: ${region.text().match(/\[server\] registered with world .*/) [0]}`);
    await waitFor("region-listen", () => region.text().includes("[server] listening on"), 60_000, region.text);
    const readyLine = region.text().match(/\[server\] listening on .*/) [0];
    say(`region ready ${Date.now() - t0} ms after spawn — ${readyLine}`);

    // 4. The same wire handshake, now against the fleet-backed region.
    const { HeadlessClient } = await import(pathToFileURL(path.join(engineDist, "test", "net", "headless-client.js")).href);
    const { MessageType, decodeSnapshot } = await import("@mmo-engine/protocol");
    const client = new HeadlessClient();
    await client.connect(`ws://127.0.0.1:${REGION_PORT}`);
    const snapP = client.waitFor(MessageType.Snapshot, 1, 15000);
    const welcome = await client.hello(USER, { username: USER, password: PASSWORD }).catch((e) => fail("hello", e.message));
    say(`welcome: player_entity=${welcome.player_entity} session_token=${welcome.session_token ? "issued" : "MISSING"}`);
    const [snapPayload] = await snapP.catch((e) => fail("snapshot", e.message));
    const snap = decodeSnapshot(snapPayload);
    say(`snapshot: ${snapPayload.length} bytes, tick=${snap.tick}, transform rows=${snap.transforms.length}`);
    const deltas = await client.waitFor(MessageType.Delta, 1, 10000).catch(() => null);
    say(deltas ? `delta: received (${deltas[0].length} bytes) — tick stream live` : "delta: none within 10s (recorded, not fatal)");
    await client.close();

    // 5. Shutdown inside-out: region, world, surreal. Ports must free up.
    await stop(region, "region");
    await stop(world, "world");
    await stop(surreal, "surreal");
    for (const p of [REGION_PORT, WORLD_PORT, SURREAL_PORT]) {
      if (!(await portFree(p))) fail("shutdown", `port ${p} still bound`);
    }
    say(`ports ${REGION_PORT}/${WORLD_PORT}/${SURREAL_PORT} all free`);
    say("RESULT: PASS (surreal + world + fleet region registered, handshake complete, clean shutdown)");
  } finally {
    for (const h of children) if (!h.exit) h.proc.kill("SIGKILL");
    if (!failed && process.env.BOOT_SMOKE_KEEP !== "1") fs.rmSync(scratch, { recursive: true, force: true });
    if (failed) { console.error(`[fleet-smoke] FAIL ${failed}`); process.exit(1); }
  }
}

main().catch(() => process.exit(1));
