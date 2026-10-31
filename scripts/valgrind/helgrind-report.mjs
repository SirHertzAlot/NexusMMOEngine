/**
 * Reads valgrind's helgrind XML and says who owns the code at fault in each
 * thread error. helgrind.mjs runs the gate on it; scripts/test/
 * helgrind-report.test.mjs pins the rules.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

/** Frames of the allocator and C/C++ runtime: skipped to find the code at fault. */
const RUNTIME = /vgpreload_|\/libc[.-]|\/libstdc\+\+|\/libm[.-]|\/libgcc|ld-linux/;

/** The folder of code an addon builds in from elsewhere (Jolt, in physics). */
const VENDORED = "third_party";

/** The folder of installed packages (node-addon-api, which our headers include). */
const INSTALLED = "node_modules";

const decode = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The inner text of the first <tag> in xml, entities decoded. */
function text(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decode(m[1].trim()) : "";
}

/** The inner XML of every <tag> in xml, in order. */
function all(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
}

/**
 * The errors in a helgrind report. stacks[0] is the access valgrind reports;
 * the others are what it conflicts with. A frame's file is absolute when
 * valgrind also gave its directory, which it does for a binary with debug info.
 */
export function parseReport(xml) {
  return all(xml, "error").map((e) => ({
    kind: text(e, "kind"),
    what: text(e, "what") || text(all(e, "xwhat")[0] ?? "", "text"),
    stacks: all(e, "stack").map((s) =>
      all(s, "frame").map((f) => {
        const file = text(f, "file");
        const dir = text(f, "dir");
        return {
          obj: text(f, "obj"),
          fn: text(f, "fn"),
          file: file && dir ? resolve(dir, file) : file,
          line: text(f, "line"),
        };
      }),
    ),
  }));
}

/** Whether a path lies outside the repo at root. */
function outsideRepo(path, root) {
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Library code that isn't blamed for its own faults: the standard library, the
 * compiler's and Node's headers (all outside the repo), and node-addon-api
 * (in node_modules). It runs on behalf of whoever called it.
 */
function isPlumbing(frame, root) {
  if (frame.file === "") return false;
  return outsideRepo(frame.file, root) || relative(root, frame.file).split(sep).includes(INSTALLED);
}

/**
 * The frame where the code at fault is: the first that isn't the allocator, a
 * runtime helper, or library plumbing. So a std::atomic or std::mutex operation
 * is blamed on the code that used it.
 */
export function faultFrame(err, root) {
  return err.stacks[0]?.find((f) => !RUNTIME.test(f.obj) && !isPlumbing(f, root));
}

/**
 * Who owns the code at fault, for an addon whose binaries are `addon.binaries`
 * and whose folder is `addon.at`, in the repo at `root`:
 *   "ours"      the addon's own code. Without debug info there is no file to
 *               check, so any fault in its binary counts as ours (Jolt's too)
 *   "vendored"  code from a third_party folder (Jolt, in physics)
 *   "node"      Node, V8 and libc, or no fault at all
 * The code at fault decides, not the other access of a race, so a fault in
 * vendored code counts as vendored even when our call started it. ThreadSanitizer
 * is the check for that.
 */
export function classify(err, addon, root) {
  const fault = faultFrame(err, root);
  if (fault === undefined || !addon.binaries.includes(fault.obj)) return "node";
  if (fault.file === "") return "ours";
  return relative(root, resolve(addon.at, fault.file)).split(sep).includes(VENDORED) ? "vendored" : "ours";
}
