// CI diagnostic for the Test step. The step loads this file with NODE_OPTIONS, so every Node
// process it starts runs it. A process that exits non-zero appends a record to EXIT_TRACE_LOG.
// It only observes: it never changes an exit code, and without EXIT_TRACE_LOG it does nothing.
const { appendFileSync } = require("node:fs");

const logPath = process.env.EXIT_TRACE_LOG;

if (logPath) {
  process.on("exit", (code) => {
    if (code === 0) return;
    try {
      const handles = process.getActiveResourcesInfo().join(", ") || "none";
      appendFileSync(
        logPath,
        `pid ${process.pid} exited ${code}\n` +
          `  argv: ${process.argv.join(" ")}\n` +
          `  cwd: ${process.cwd()}\n` +
          `  active handles: ${handles}\n`,
      );
    } catch {
      // Recording must never change how the process ends.
    }
  });
}
