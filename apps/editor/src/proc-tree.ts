/**
 * Process-tree kill for locally spawned helpers (editor dev host).
 *
 * `spawn(..., { detached: true })` makes the child lead its own process
 * group, so a signal to the group reaches the whole tree — the shell
 * wrapper AND the real process (a sidecar's `node` grandchild, the
 * server's npm → sh → node chain). Killing just the wrapper would orphan
 * the real process. Still only ever OUR trees: callers pass pids they
 * spawned themselves.
 */

import { spawnSync } from "node:child_process";

export function killProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): void {
  if (pid <= 0) return;
  try {
    if (platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    /* already gone */
  }
}
