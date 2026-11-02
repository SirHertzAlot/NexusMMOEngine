import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTsan, parseFrame, parseTsanReports } from "../valgrind/tsan-report.mjs";

// A fake checkout with one addon, its binary, and the files a stack can name.
const root = "/repo";
const at = "/repo/packages/addons/physics";
const binary = `${at}/build/Release/physics.node`;
const addon = { at, binaries: [binary] };
const ours = `${at}/src/physics.cc`;
const jolt = `${at}/third_party/JoltPhysics/Jolt/Core/JobSystemThreadPool.cpp`;
const stdlib = "/usr/include/c++/13/bits/atomic_base.h";

/** A data race whose access stack has these frames; the other access is V8's. */
const race = (...frames) =>
  [
    "==================",
    "WARNING: ThreadSanitizer: data race (pid=4242)",
    "  Write of size 8 at 0x7b0400000010 by thread T2:",
    ...frames,
    "",
    "  Previous read of size 8 at 0x7b0400000010 by main thread:",
    "    #0 Read() (node+0x1000)",
    "",
    "SUMMARY: ThreadSanitizer: data race /repo/packages/addons/physics/src/physics.cc:42 in Step()",
    "==================",
  ].join("\n");

/** How the only report in a log is classified. */
function verdict(text) {
  const reports = parseTsanReports(text);
  assert.equal(reports.length, 1);
  return classifyTsan(reports[0], addon, root);
}

test("code in the addon's own sources is ours", () => {
  assert.equal(verdict(race(`    #0 Step() ${ours}:42 (physics.node+0x1a2b)`)), "ours");
});

test("code from third_party is vendored", () => {
  assert.equal(verdict(race(`    #0 Job() ${jolt}:118 (physics.node+0x1a2b)`)), "vendored");
});

test("code Jolt calls into is blamed on Jolt, not on our call", () => {
  assert.equal(
    verdict(race(`    #0 Job() ${jolt}:118 (physics.node+0x10)`, `    #1 Step() ${ours}:42 (physics.node+0x20)`)),
    "vendored",
  );
});

test("standard-library code is blamed on the code that called it", () => {
  assert.equal(
    verdict(race(`    #0 load() ${stdlib}:70 (physics.node+0x10)`, `    #1 Step() ${ours}:42 (physics.node+0x20)`)),
    "ours",
  );
});

test("sanitizer and libc frames are skipped to find the code at fault", () => {
  assert.equal(
    verdict(
      race(
        "    #0 __tsan_write8 ../../../../src/libsanitizer/tsan/tsan_rtl.cpp:614 (libtsan.so.2+0x4f2)",
        "    #1 pthread_mutex_lock (libc.so.6+0x1234)",
        `    #2 Step() ${ours}:42 (physics.node+0x20)`,
      ),
    ),
    "ours",
  );
});

test("a fault in V8 or Node is not ours, even when our callback started it", () => {
  assert.equal(verdict(race("    #0 v8::Object::Get() (node+0x1000)", `    #1 Step() ${ours}:42 (physics.node+0x20)`)), "node");
});

test("node-only stacks have no fault in the addon", () => {
  assert.equal(verdict(race("    #0 <null> <null> (node+0x99)")), "node");
});

test("a relative file is read from the addon's folder", () => {
  assert.equal(verdict(race("    #0 Step() src/physics.cc:7 (physics.node+0x20)")), "ours");
  assert.equal(verdict(race("    #0 Job() third_party/JoltPhysics/Jolt/Core/Job.cpp:9 (physics.node+0x20)")), "vendored");
});

test("without debug info, a fault in the addon's binary counts as ours", () => {
  assert.equal(verdict(race("    #0 Step() (physics.node+0x20)")), "ours");
  assert.equal(verdict(race(`    #0 Step() (${binary}+0x20)`)), "ours");
});

test("parses each report's kind and stacks, and stops at its summary", () => {
  const text = [
    race(`    #0 Step() ${ours}:42 (physics.node+0x1a2b)`, `    #1 Tick() ${ours}:80 (physics.node+0x3c4d)`),
    "==================",
    "WARNING: ThreadSanitizer: lock-order-inversion (potential deadlock) (pid=7)",
    "  Cycle in lock order graph: M1 (0x1) => M2 (0x2) => M1",
    "",
    "  Mutex M2 acquired here while holding mutex M1 in thread T1:",
    `    #0 lock() ${stdlib}:5 (physics.node+0x9)`,
    "SUMMARY: ThreadSanitizer: lock-order-inversion (potential deadlock) /repo/x.cc:1 in lock",
    "==================",
  ].join("\n");
  const reports = parseTsanReports(text);
  assert.deepEqual(
    reports.map((r) => r.kind),
    ["data race", "lock-order-inversion (potential deadlock)"],
  );
  assert.equal(reports[0].stacks.length, 2, "the access stack and the other access");
  assert.equal(reports[0].stacks[0].length, 2);
  assert.equal(reports[0].stacks[0][0].file, ours);
  assert.equal(reports[0].stacks[0][0].line, 42);
  assert.equal(reports[0].stacks[0][0].module, "physics.node");
  assert.equal(reports[1].stacks.length, 1);
});

test("a frame's function, file, line and module are read from its text", () => {
  assert.deepEqual(parseFrame("pthread_mutex_lock (libc.so.6+0x1234)"), {
    fn: "pthread_mutex_lock",
    file: "",
    line: 0,
    module: "libc.so.6",
  });
  assert.deepEqual(parseFrame(`0x7f9b in Step() ${ours}:12:3 (physics.node+0x5)`), {
    fn: "Step()",
    file: ours,
    line: 12,
    module: "physics.node",
  });
  assert.deepEqual(parseFrame("<null> <null> (node+0x99)"), { fn: "<null> <null>", file: "", line: 0, module: "node" });
});

test("recent TSan builds add the module's build id, which is not a module", () => {
  // The frame of a real two-thread race in a -g build (gcc's TSan).
  const real = "bump /tmp/race/race.c:5 (race+0x128b) (BuildId: 890e76481652e4bb9cfdafb04ffd8398323247c8)";
  assert.deepEqual(parseFrame(real), { fn: "bump", file: "/tmp/race/race.c", line: 5, module: "race" });
});

test("a real race in our sources is ours, with build ids on its frames", () => {
  const frame = (n) =>
    `    #${n} bump ${ours}:5 (physics.node+0x128b) (BuildId: 890e76481652e4bb9cfdafb04ffd8398323247c8)`;
  const text = [
    "==================",
    "WARNING: ThreadSanitizer: data race (pid=21573)",
    "  Write of size 4 at 0x000001234 by thread T2:",
    frame(0),
    "",
    "  Previous write of size 4 at 0x000001234 by thread T1:",
    frame(0),
    "SUMMARY: ThreadSanitizer: data race /x.c:5 in bump",
    "==================",
  ].join("\n");
  assert.equal(verdict(text), "ours");
});
