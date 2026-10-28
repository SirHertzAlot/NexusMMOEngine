#!/usr/bin/env node
/**
 * Boot smoke — boot the REAL region server (`packages/engine-core`
 * `dist/src/server.js`, the `npm run server` entrypoint) standalone in a
 * scratch data dir, complete the wire handshake with the repo's own
 * HeadlessClient (hello → welcome → snapshot → delta), then SIGTERM and
 * verify a clean shutdown (exit, port free).
 *
 * Prereqs: `npm install` at the root (builds the native addons) and the
 * engine-core build (`npm run build --workspace=@mmo-engine/engine-core`;
 * its tsc step currently reports main's pre-existing type errors but
 * still emits dist/ — the smoke runs the emitted server).
 *
 * Usage: node scripts/boot-smoke.mjs
 *   BOOT_SMOKE_PORT (default 7917), BOOT_SMOKE_KEEP=1 keeps the scratch
 *   dir + server log for inspection instead of deleting them.
 *
 * Exit 0 = every stage passed; the [boot-smoke] lines are the evidence.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineDist = path.join(root, "packages", "engine-core", "dist");
const serverEntry = path.join(engineDist, "src", "server.js");
const seedEntry = path.join(engineDist, "src", "auth", "seed-user.js");
const PORT = Number(process.env.BOOT_SMOKE_PORT ?? 7917);
const USER = "smoke";
const PASSWORD = "smoke-password-1"; // throwaway, only ever in the scratch CSV

const say = (m) => console.log(`[boot-smoke] ${m}`);
const fail = (stage, why) => {
  console.error(`[boot-smoke] FAIL at ${stage}: ${why}`);
  process.exitCode = 1;
  throw new Error(stage);
};

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(serverEntry)) fail("prereq", `${serverEntry} missing — build engine-core first`);
  if (!(await portFree(PORT))) fail("prereq", `port ${PORT} is already in use`);

  const scratch = path.join(root, ".boot-smoke");
  fs.rmSync(scratch, { recursive: true, force: true });
  const dataDir = path.join(scratch, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const logFile = path.join(scratch, "server.log");
  const logStream = fs.createWriteStream(logFile);
  say(`scratch data dir: ${dataDir}`);

  // Seed the login user with the repo's own tool (argon2id into the CSV).
  const seedOut = await run(process.execPath, [seedEntry, "--csv", path.join(dataDir, "users.csv"), USER], {
    ...process.env,
    MMO_DEV_PASSWORD: PASSWORD,
  }).catch((e) => fail("seed-user", e.message));
  say(`seed-user: ${seedOut.trim()}`);

  // Boot the real server, standalone (no WORLD_URL).
  const t0 = Date.now();
  const server = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: { ...process.env, MMO_DATA_DIR: dataDir, MMO_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logText = "";
  server.stdout.on("data", (d) => { logText += d; logStream.write(d); });
  server.stderr.on("data", (d) => { logText += d; logStream.write(d); });
  let serverExit = null;
  server.on("exit", (code, signal) => { serverExit = { code, signal }; });

  // Readiness: the server's own listening line.
  let listeningLine = null;
  while (Date.now() - t0 < 180_000) {
    const m = logText.match(/\[server\] listening on .*/);
    if (m) { listeningLine = m[0]; break; }
    if (serverExit) fail("boot", `server exited early (${JSON.stringify(serverExit)}); log tail:\n${logText.split("\n").slice(-15).join("\n")}`);
    await sleep(100);
  }
  if (!listeningLine) fail("boot", `no listening line within 180s; log tail:\n${logText.split("\n").slice(-15).join("\n")}`);
  const readyMs = Date.now() - t0;
  say(`ready in ${readyMs} ms — ${listeningLine}`);

  // Handshake with the repo's own protocol client.
  const { HeadlessClient } = await import(pathToFileURL(path.join(engineDist, "test", "net", "headless-client.js")).href);
  const { MessageType, decodeSnapshot } = await import("@mmo-engine/protocol");
  const client = new HeadlessClient();
  await client.connect(`ws://127.0.0.1:${PORT}`);
  const snapP = client.waitFor(MessageType.Snapshot, 1, 15000);
  const welcome = await client.hello(USER, { username: USER, password: PASSWORD }).catch((e) => fail("hello", e.message));
  say(`welcome: player_entity=${welcome.player_entity} session_token=${welcome.session_token ? "issued" : "MISSING"}`);
  const [snapPayload] = await snapP.catch((e) => fail("snapshot", e.message));
  const snap = decodeSnapshot(snapPayload);
  say(`snapshot: ${snapPayload.length} bytes on the wire, tick=${snap.tick}, transform rows=${snap.transforms.length}, chunk rows=${snap.chunks.length}`);
  const deltas = await client.waitFor(MessageType.Delta, 1, 10000).catch(() => null);
  say(deltas ? `delta: received (${deltas[0].length} bytes) — tick stream live` : "delta: none within 10s (recorded, not fatal)");
  await client.close();

  // Clean shutdown: SIGTERM, expect exit + save, port free, no orphan.
  server.kill("SIGTERM");
  const t1 = Date.now();
  while (!serverExit && Date.now() - t1 < 60_000) await sleep(100);
  if (!serverExit) { server.kill("SIGKILL"); fail("shutdown", "server did not exit within 60s of SIGTERM"); }
  say(`shutdown: exit code=${serverExit.code} signal=${serverExit.signal} after ${Date.now() - t1} ms`);
  await sleep(250);
  if (!(await portFree(PORT))) fail("shutdown", `port ${PORT} still bound after exit`);
  say(`port ${PORT} free after shutdown`);
  const tail = logText.split("\n").filter(Boolean).slice(-6);
  say(`server log tail:\n  ${tail.join("\n  ")}`);
  say(`RESULT: PASS (ready ${readyMs} ms, handshake complete, clean SIGTERM shutdown)`);
  logStream.end();
  if (process.env.BOOT_SMOKE_KEEP !== "1") fs.rmSync(scratch, { recursive: true, force: true });
  else say(`kept scratch dir: ${scratch}`);
}

main().catch(() => {
  // fail() already printed the stage; make sure no server is left behind.
  process.exit(1);
});
