/**
 * Reads ThreadSanitizer's reports and says who owns the code at fault in each.
 * tsan.mjs runs the gate on it; scripts/test/tsan-report.test.mjs pins the rules.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

/** Frames of the sanitizer, the allocator and the C/C++ runtime: skipped to find the code at fault. */
const RUNTIME = /(^|\/)libc[.-]|libstdc\+\+|(^|\/)libm[.-]|libgcc|ld-linux|libtsan|libclang_rt|libasan|libubsan|vgpreload/;

/** The folder of code an addon builds in from elsewhere (Jolt, in physics). */
const VENDORED = "third_party";

/** The folder of installed packages (node-addon-api, which our headers include). */
const INSTALLED = "node_modules";

const WARNING = /^WARNING: ThreadSanitizer: (.*?)(?: \(pid=\d+\))?$/;
const SEPARATOR = /^=+$/;
const SUMMARY = /^SUMMARY: ThreadSanitizer/;
const FRAME = /^\s*#(\d+) (.*\S)\s*$/;

/**
 * One frame's body (what follows "#n "): its function, its file and line when the
 * build has debug info, and the module it is in, as in `fn file:line (module+0x1f)`.
 * Recent TSan adds the module's build id after that, as in `(BuildId: 8f3a...)`.
 */
export function parseFrame(body) {
  const text = body.replace(/\s*\(BuildId: [0-9a-fA-F]+\)\s*$/, "");
  const mod = /\(([^()]*\+0x[0-9a-fA-F]+)\)$/.exec(text);
  const module = mod ? mod[1].replace(/\+0x[0-9a-fA-F]+$/, "") : "";
  const head = mod ? text.slice(0, mod.index).trim() : text.trim();
  const loc = /(\S+?):(\d+)(?::\d+)?$/.exec(head);
  const fn = (loc ? head.slice(0, loc.index) : head).trim().replace(/^0x[0-9a-fA-F]+ in /, "");
  return { fn, file: loc ? loc[1] : "", line: loc ? Number(loc[2]) : 0, module };
}

/**
 * The reports in a ThreadSanitizer log. Each report has `kind` (such as "data
 * race") and `stacks`: the stacks in it, in order. stacks[0] is the access
 * TSan reports; the others are what it conflicts with, or where a thread or a
 * block came from.
 */
export function parseTsanReports(text) {
  const reports = [];
  let report = null;
  let frames = null;
  const close = () => {
    if (report && frames) report.stacks.push(frames);
    frames = null;
  };
  for (const line of text.split("\n")) {
    const warning = WARNING.exec(line.trim());
    if (warning) {
      close();
      report = { kind: warning[1].trim(), stacks: [] };
      reports.push(report);
      continue;
    }
    if (!report) continue;
    if (SEPARATOR.test(line.trim()) || SUMMARY.test(line)) {
      close();
      report = null;
      continue;
    }
    const frame = FRAME.exec(line);
    if (frame) {
      (frames ??= []).push({ n: Number(frame[1]), ...parseFrame(frame[2]) });
      continue;
    }
    // A header line ("Previous write of size 8 at ...") ends the stack before it.
    close();
  }
  close();
  return reports;
}

/** Where a frame's file is: absolute, or relative to the addon's folder (its build directory's sources). */
function locate(frame, addon) {
  return isAbsolute(frame.file) ? frame.file : resolve(addon.at, frame.file);
}

/** Whether a module is one of the addon's binaries, by its path or its file name. */
function isAddonModule(module, addon) {
  return addon.binaries.some((b) => module === b || module.endsWith(`/${b.split(sep).pop()}`) || module === b.split(sep).pop());
}

/** Library code that isn't blamed for its own faults: the standard library, the compiler's and Node's headers, and node-addon-api. */
function isPlumbing(frame, addon, root) {
  if (frame.file === "") return false;
  const rel = relative(root, locate(frame, addon));
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep).includes(INSTALLED);
}

/**
 * Who owns the code at fault in a report, for an addon (`addon.at` is its folder,
 * `addon.binaries` its built binaries), in the repo at `root`:
 *   "ours"      the addon's own code. Without debug info, any fault in its binary counts as ours
 *   "vendored"  code from a third_party folder (Jolt, in physics)
 *   "node"      Node, V8 and libc, or no fault at all
 * The fault is the innermost frame that isn't the runtime or library plumbing,
 * so a race inside std::atomic is blamed on the code that used it. The code at
 * fault decides, not the other access, as in helgrind-report.mjs.
 */
export function classifyTsan(report, addon, root) {
  const fault = report.stacks[0]?.find((f) => !RUNTIME.test(f.module) && !isPlumbing(f, addon, root));
  if (!fault) return "node";
  if (fault.file === "") return isAddonModule(fault.module, addon) ? "ours" : "node";
  const rel = relative(addon.at, locate(fault, addon));
  const inside = rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (inside) return rel.split(sep).includes(VENDORED) ? "vendored" : "ours";
  return isAddonModule(fault.module, addon) ? "ours" : "node";
}
