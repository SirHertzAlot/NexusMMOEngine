// Serves scripts/valgrind/dashboard.html, its data, and a few whitelisted jobs
// on loopback only. Usage: npm run valgrind:dashboard [-- --port 5180]
//
//   GET  /api/reports    memcheck XML     GET /api/callgrind   instruction counts
//   GET  /api/history    recorded runs    GET /api/run         the job's state and log tail
//   POST /api/run        {job}: start memcheck | perf | record | promote
//   POST /api/run/cancel stop the job we started
//
// POST needs the X-Valgrind-Dashboard header: a page on another origin can't
// send it without a CORS preflight, which this server never answers.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callgrind, history, memcheckReports, root } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const i = process.argv.indexOf("--port");
const port = i > 0 ? Number(process.argv[i + 1]) : 5180;

const JOBS = {
  memcheck: ["run", "valgrind:memcheck"],
  perf: ["run", "valgrind:perf"],
  record: ["run", "valgrind:record"],
  promote: ["run", "valgrind:record", "--", "--promote"],
};
const LOG_MAX = 64 * 1024;
let job = null; // { name, startedAt, log, exitCode, child }

function npm(args) {
  const cli = process.env.npm_execpath;
  if (cli && basename(cli) === "npm-cli.js") return { command: process.execPath, args: [cli, ...args], shell: false };
  return process.platform === "win32"
    ? { command: ["npm.cmd", ...args].join(" "), args: [], shell: true }
    : { command: "npm", args, shell: false };
}

function start(name) {
  const { command, args, shell } = npm(JOBS[name]);
  const state = { name, startedAt: Date.now(), log: "", exitCode: null, child: null };
  const add = (d) => { state.log = (state.log + d).slice(-LOG_MAX); };
  // Its own process group on POSIX, so cancel can stop valgrind and not just npm.
  const child = spawn(command, args, { cwd: root, shell, detached: process.platform !== "win32", env: { ...process.env, FORCE_COLOR: "0" } });
  state.child = child;
  child.stdout.on("data", add);
  child.stderr.on("data", add);
  child.on("error", (e) => { add(`\n[dashboard] could not start: ${e.message}\n`); state.exitCode = -1; });
  child.on("close", (code, signal) => { state.exitCode = code ?? (signal ? -1 : 0); state.child = null; });
  job = state;
}

const view = () => job && { name: job.name, running: job.exitCode === null, exitCode: job.exitCode, seconds: Math.round((Date.now() - job.startedAt) / 1000), log: job.log };
const readBody = (req) => new Promise((ok) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => ok(b)); });

createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  const json = (code, body) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };
  if (req.method === "POST") {
    if (req.headers["x-valgrind-dashboard"] !== "1") return json(403, { error: "missing X-Valgrind-Dashboard header" });
    if (path === "/api/run") {
      let name;
      try { name = JSON.parse(await readBody(req)).job; } catch { return json(400, { error: "body must be JSON like {\"job\":\"memcheck\"}" }); }
      if (!Object.hasOwn(JOBS, name)) return json(400, { error: `unknown job; one of ${Object.keys(JOBS).join(", ")}` });
      if (job && job.exitCode === null) return json(409, { error: `${job.name} is still running`, run: view() });
      start(name);
      return json(200, { run: view() });
    }
    if (path === "/api/run/cancel") {
      if (job?.child) {
        try { process.platform === "win32" ? job.child.kill() : process.kill(-job.child.pid, "SIGTERM"); } catch { /* already gone */ }
      }
      return json(200, { run: view() });
    }
    return json(404, { error: "not found" });
  }
  if (path === "/api/reports") json(200, { files: memcheckReports() });
  else if (path === "/api/callgrind") json(200, callgrind());
  else if (path === "/api/history") json(200, history());
  else if (path === "/api/run") json(200, { run: view() });
  else if (path === "/") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(readFileSync(join(here, "dashboard.html"), "utf8"));
  } else { res.statusCode = 404; res.end("not found"); }
}).listen(port, "127.0.0.1", () => console.log(`Valgrind dashboard: http://localhost:${port}`));
