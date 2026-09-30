#!/usr/bin/env node
/**
 * `npm run dev`: the development environment. The game server and the
 * client in developer mode (its dev panels: performance graphs, wireframe,
 * the FX showcase), each line of their output prefixed with its name.
 * Ctrl+C, or either one exiting, stops both.
 *
 * `npm run client` is the player's client alone, without any of this.
 * When the editor's play mode embeds the game view (docs/ROADMAP.md E4),
 * the dev panels move there and this starts the editor instead.
 */

import { spawn } from "node:child_process";

const SERVER = { name: "server", args: ["run", "server"] };
const CLIENT = { name: "client", args: ["run", "dev:tools", "--workspace=@mmo-engine/client"] };

const children = [];
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) kill(c);
  // Give them a moment to save (the server writes its last tick), then go.
  setTimeout(() => process.exit(code), 3000).unref();
}

/** Stop a child and what it started (npm runs the server under a shell). */
function kill(child) {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM"); // its process group
  } catch {
    child.kill("SIGTERM");
  }
}

/** Run one npm script, its output prefixed; `onLine` sees each stdout line. */
function run(p, onLine = () => {}) {
  // npm is npm.cmd on Windows, which needs a shell to run.
  // Each in its own process group (POSIX), so stopping it stops everything under it.
  const win = process.platform === "win32";
  const child = spawn("npm", p.args, { stdio: ["ignore", "pipe", "pipe"], shell: win, detached: !win });
  children.push(child);
  const prefix = (stream, out, see) => {
    let rest = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) {
        out.write(`[${p.name}] ${line}\n`);
        see(line);
      }
    });
    stream.on("end", () => rest && out.write(`[${p.name}] ${rest}\n`));
  };
  prefix(child.stdout, process.stdout, onLine);
  prefix(child.stderr, process.stderr, () => {});
  child.on("exit", (code) => {
    if (!stopping) console.log(`[dev] ${p.name} exited (${code ?? "signal"}); stopping the rest`);
    stop(code ?? 0);
  });
}

// The server first: its build compiles the shared packages the client
// needs too, and the client connects to it. The client starts once the
// server is listening.
let clientStarted = false;
run(SERVER, (line) => {
  if (clientStarted || !/listening on/.test(line)) return;
  clientStarted = true;
  run(CLIENT);
});

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
