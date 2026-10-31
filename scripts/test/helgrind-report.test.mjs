import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, parseReport } from "../valgrind/helgrind-report.mjs";

// A fake checkout with one addon, its binary, and the frames a stack can hold.
const root = "/repo";
const at = `${root}/packages/addons/physics`;
const binary = `${at}/build/Release/physics.node`;
const addon = { at, binaries: [binary] };
const libc = "/usr/lib/x86_64-linux-gnu/libc.so.6";
const node = "/usr/bin/node";
const ourSource = { dir: `${at}/src`, file: "physics.cc" };
const jolt = { dir: `${at}/third_party/JoltPhysics/Jolt/Core`, file: "JobSystemThreadPool.cpp" };
const stdlib = { dir: "/usr/include/c++/13/bits", file: "atomic_base.h", fn: "load" };
const installed = { dir: `${root}/node_modules/node-addon-api`, file: "napi.h" };

const frame = ({ obj = binary, fn = "Step", dir, file, line = 1 }) =>
  `<frame><obj>${obj}</obj><fn>${fn}</fn>${dir ? `<dir>${dir}</dir>` : ""}${file ? `<file>${file}</file>` : ""}<line>${line}</line></frame>`;
const stack = (...frames) => `<stack>${frames.join("")}</stack>`;
const error = (kind, ...stacks) =>
  `<error><kind>${kind}</kind><xwhat><text>thread error</text></xwhat>${stacks.join("")}</error>`;
const report = (...errors) => `<valgrindoutput>${errors.join("")}</valgrindoutput>`;

/** How the only error in a report, with these stacks, is classified. */
function verdict(...stacks) {
  const errors = parseReport(report(error("Race", ...stacks)));
  assert.equal(errors.length, 1);
  return classify(errors[0], addon, root);
}

test("code in the addon's own sources is ours", () => {
  assert.equal(verdict(stack(frame(ourSource))), "ours");
});

test("native code beside the sources is ours too", () => {
  assert.equal(verdict(stack(frame({ dir: `${at}/native`, file: "physics_world.cpp" }))), "ours");
});

test("code the addon vendors is vendored", () => {
  assert.equal(verdict(stack(frame(jolt))), "vendored");
});

test("code Jolt calls into is blamed on Jolt, not on our call", () => {
  assert.equal(verdict(stack(frame(jolt), frame(ourSource))), "vendored");
});

test("standard-library code is blamed on the code that called it", () => {
  assert.equal(verdict(stack(frame(stdlib), frame(ourSource))), "ours");
});

test("node-addon-api code is blamed on the code that called it", () => {
  assert.equal(verdict(stack(frame(installed), frame(ourSource))), "ours");
});

test("library code alone has no fault", () => {
  assert.equal(verdict(stack(frame(stdlib))), "node");
  assert.equal(verdict(stack(frame({ dir: "/root/.cache/node-gyp/22.0.0/include/node", file: "node.h" }))), "node");
});

test("without debug info, a fault in the addon's binary counts as ours", () => {
  assert.equal(verdict(stack(frame({ fn: "CreateJob" }))), "ours");
});

test("the allocator and runtime helpers are skipped to find the code at fault", () => {
  assert.equal(verdict(stack(frame({ obj: libc, fn: "malloc" }), frame(ourSource))), "ours");
});

test("a fault in Node or V8 is not ours, even with our code further down", () => {
  assert.equal(verdict(stack(frame({ obj: node, fn: "uv_run" }), frame(ourSource))), "node");
});

test("a stack of runtime helpers alone has no fault", () => {
  assert.equal(verdict(stack(frame({ obj: libc, fn: "memcpy" }))), "node");
});

test("only the first stack decides", () => {
  assert.equal(verdict(stack(frame({ obj: node, fn: "uv_run" })), stack(frame(ourSource))), "node");
});

test("an error without stacks has no fault", () => {
  assert.equal(classify(parseReport(report(error("Race")))[0], addon, root), "node");
});

test("a frame's file is joined to its directory", () => {
  const [err] = parseReport(report(error("Race", stack(frame({ ...ourSource, line: 42 })))));
  assert.deepEqual(err.stacks[0][0], { obj: binary, fn: "Step", file: `${at}/src/physics.cc`, line: "42" });
});

test("entities in names are decoded", () => {
  const [err] = parseReport(report(error("Race", stack(frame({ fn: "Foo&lt;int&gt;::bar&amp;&amp;" })))));
  assert.equal(err.stacks[0][0].fn, "Foo<int>::bar&&");
});
