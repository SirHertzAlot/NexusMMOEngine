// Shared readers for the Valgrind dashboard, snapshot recorder and server.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const memcheckDir = join(root, "valgrind-out", "memcheck");
export const callgrindDir = join(root, "valgrind-out", "callgrind");
export const localHistoryDir = join(root, "valgrind-out", "history");
export const baselineFile = join(root, "perf", "callgrind-baseline.json");
export const historyFile = join(root, "perf", "history.json");

const listFiles = (dir, ext) => {
  try { return readdirSync(dir).filter((n) => !ext || n.endsWith(ext)).sort(); } catch { return []; }
};
const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
};

export function memcheckReports() {
  return listFiles(memcheckDir, ".xml").map((name) => ({
    name,
    modified: statSync(join(memcheckDir, name)).mtimeMs,
    xml: readFileSync(join(memcheckDir, name), "utf8"),
  }));
}

export function callgrind() {
  const baseline = readJson(baselineFile, { workloads: {} });
  const found = new Map();
  for (const f of listFiles(callgrindDir)) {
    const text = readFileSync(join(callgrindDir, f), "utf8");
    const name = /^desc: Trigger: Client Request: (.+)$/m.exec(text)?.[1].trim();
    const ir = /^totals: (\d+)/m.exec(text) ?? /^summary: (\d+)/m.exec(text);
    if (name && ir) found.set(name, { ir: Number(ir[1]) });
  }
  const names = new Set([...found.keys(), ...Object.keys(baseline.workloads)]);
  const workloads = [...names].sort().map((name) => {
    const b = baseline.workloads[name];
    const m = found.get(name);
    const irPerOp = m && b ? m.ir / b.n : null;
    return {
      name, unit: b?.unit ?? "op", n: b?.n ?? null, ir: m?.ir ?? null, irPerOp,
      baseline: b?.irPerOp ?? null,
      deltaPct: irPerOp !== null && b ? ((irPerOp - b.irPerOp) / b.irPerOp) * 100 : null,
    };
  });
  const baselineNode = baseline.node ?? null, node = runNode();
  return { baselineNode, runNode: node, nodeMismatch: Boolean(baselineNode && node && baselineNode !== node), workloads };
}

const unescapeXml = (x) => x.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const nodeVersionOf = (text) => /\/v(\d+\.\d+\.\d+)\/bin\/node/.exec(text)?.[1];

// Allocator and C/C++ runtime frames: same list as memcheck.mjs.
const RUNTIME_FRAME = /vgpreload_|\/libc[.-]|\/libstdc\+\+|\/libm[.-]|\/libgcc|ld-linux/;

/**
 * The errors of one memcheck report, classed the way memcheck.mjs gates them:
 *   engine   the first frame past the allocator is in one of our addons (*.node):
 *            the code at fault is ours.
 *   via      our code is somewhere on the stack but the fault is in Node or V8
 *            (a GC read, an external never finalised at exit): worth a look,
 *            not our fault by itself.
 *   runtime  Node, V8 or libc only.
 * The origin is the frame to read first: ours for engine and via, else the first
 * frame past the allocator.
 */
export function parseErrors(xml) {
  return [...xml.matchAll(/<error>([\s\S]*?)<\/error>/g)].map(([, e]) => {
    const stack = [...(/<stack>([\s\S]*?)<\/stack>/.exec(e)?.[1] ?? "").matchAll(/<frame>([\s\S]*?)<\/frame>/g)].map(([, f]) => {
      const file = tag(f, "file");
      return { fn: unescapeXml(tag(f, "fn") || tag(f, "ip")), obj: tag(f, "obj"), where: file ? `${file}:${tag(f, "line")}` : null };
    });
    const first = stack.find((f) => !RUNTIME_FRAME.test(f.obj));
    const ours = stack.find((f) => f.obj.endsWith(".node"));
    const cls = first?.obj.endsWith(".node") ? "engine" : ours ? "via" : "runtime";
    const origin = cls === "runtime" ? first : ours;
    return {
      kind: tag(e, "kind"), bytes: Number(tag(e, "leakedbytes")) || 0, cls,
      origin: origin?.fn ?? "unknown", location: origin?.where ?? null, stack,
    };
  });
}

const tag = (xml, t) => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(xml)?.[1].trim() ?? "";

/** Error counts per memcheck report, plus the keys of our errors, for comparing runs. */
export function memcheckSummary(files) {
  const perReport = {};
  const engineKeys = new Set(), viaKeys = new Set();
  const total = { reports: files.length, errors: 0, leakedBytes: 0, engineErrors: 0, viaErrors: 0 };
  for (const f of files) {
    const name = f.name.replace(/\.xml$/, "");
    const list = parseErrors(f.xml);
    const n = (c) => list.filter((e) => e.cls === c).length;
    perReport[name] = { errors: list.length, leakedBytes: list.reduce((a, e) => a + e.bytes, 0), engineErrors: n("engine"), viaErrors: n("via") };
    for (const e of list) {
      const key = `${name}|${e.kind}|${e.origin}`;
      if (e.cls === "engine") engineKeys.add(key);
      else if (e.cls === "via") viaKeys.add(key);
    }
    total.errors += list.length; total.leakedBytes += perReport[name].leakedBytes;
    total.engineErrors += perReport[name].engineErrors; total.viaErrors += perReport[name].viaErrors;
  }
  return { ...total, engineKeys: [...engineKeys].sort(), viaKeys: [...viaKeys].sort(), perReport };
}

/** The Node the last run used (from the command line valgrind recorded), or null if unknown. */
export function runNode() {
  for (const f of listFiles(callgrindDir)) {
    const v = nodeVersionOf(/^cmd: (.+)$/m.exec(readFileSync(join(callgrindDir, f), "utf8"))?.[1] ?? "");
    if (v) return "v" + v;
  }
  for (const f of memcheckReports()) {
    const v = nodeVersionOf(/<line>Command: (.+?)<\/line>/.exec(f.xml)?.[1] ?? "");
    if (v) return "v" + v;
  }
  return null;
}

export function snapshot() {
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" }).stdout?.trim() ?? "";
  const cg = callgrind();
  const workloads = {};
  for (const w of cg.workloads) if (w.irPerOp !== null) workloads[w.name] = { irPerOp: w.irPerOp, unit: w.unit };
  const time = new Date().toISOString();
  return {
    id: time, time,
    commit: git("rev-parse", "--short", "HEAD"),
    dirty: git("status", "--porcelain").length > 0,
    node: runNode() ?? process.version,
    memcheck: memcheckSummary(memcheckReports()),
    callgrind: workloads,
  };
}

export function localSnapshots() {
  return listFiles(localHistoryDir, ".json").map((f) => readJson(join(localHistoryDir, f), null)).filter(Boolean);
}

export function history() {
  const committed = readJson(historyFile, { entries: [] }).entries ?? [];
  const ids = new Set(committed.map((e) => e.id));
  return {
    committed: committed.map((e) => ({ ...e, source: "committed" })),
    local: localSnapshots().filter((e) => !ids.has(e.id)).map((e) => ({ ...e, source: "local" })),
  };
}

export function saveLocal(entry) {
  mkdirSync(localHistoryDir, { recursive: true });
  const file = join(localHistoryDir, entry.id.replace(/[:.]/g, "-") + ".json");
  writeFileSync(file, JSON.stringify(entry, null, 2) + "\n");
  return file;
}

export function promote(entry) {
  const doc = existsSync(historyFile) ? readJson(historyFile, null) : null;
  const out = doc?.entries ? doc : { format: "mmo-valgrind-history/1", entries: [] };
  if (out.entries.some((e) => e.id === entry.id)) return false;
  out.entries.push(entry);
  mkdirSync(dirname(historyFile), { recursive: true });
  writeFileSync(historyFile, JSON.stringify(out, null, 2) + "\n");
  return true;
}
