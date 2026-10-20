/**
 * WASM sidecar host (EA11).
 *
 * Runs a WebAssembly module as a sidecar, in-process. The .wasm file must
 * export:
 * - `health() -> i32`: returns 1 when healthy, 0 otherwise.
 * - optionally `start(port: i32)`: called once with the configured port.
 * - optionally `stop()`: called on shutdown.
 *
 * Unlike command/exec sidecars (separate OS processes), wasm sidecars run
 * in the host's process — no IPC overhead, but a crash takes the host down.
 * Use for trusted, lightweight helpers (e.g. a rule engine, a filter).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface WasmSidecarExports {
  health?: () => number;
  start?: (port: number) => void;
  stop?: () => void;
  memory?: WebAssembly.Memory;
}

export class WasmSidecarHost {
  private instance: WebAssembly.Instance | null = null;
  private readonly wasmPath: string;
  private readonly port: number;
  private readonly log: (line: string) => void;

  constructor(wasmPath: string, port: number, log: (line: string) => void = () => {}) {
    this.wasmPath = wasmPath;
    this.port = port;
    this.log = log;
  }

  /** Load and instantiate the .wasm file. */
  async start(moduleDir: string): Promise<void> {
    const full = join(moduleDir, this.wasmPath);
    const bytes = await readFile(full);
    const mod = await WebAssembly.compile(bytes);
    // Minimal imports: the module gets a memory and nothing else.
    // Real modules needing WASI should use node:wasi; this host is for
    // self-contained helpers.
    const memory = new WebAssembly.Memory({ initial: 1 });
    const imports = { env: { memory } };
    this.instance = await WebAssembly.instantiate(mod, imports);
    const exports = this.instance.exports as unknown as WasmSidecarExports;
    if (typeof exports.start === "function") {
      exports.start(this.port);
    }
    this.log(`[wasm-sidecar] started ${this.wasmPath}`);
  }

  /** Call the module's health() export; true if it returns 1. */
  healthy(): boolean {
    if (!this.instance) return false;
    const exports = this.instance.exports as unknown as WasmSidecarExports;
    if (typeof exports.health !== "function") return false;
    try {
      return exports.health() === 1;
    } catch {
      return false;
    }
  }

  /** Call stop() if exported, then drop the instance. */
  async stop(): Promise<void> {
    if (this.instance) {
      const exports = this.instance.exports as unknown as WasmSidecarExports;
      if (typeof exports.stop === "function") {
        try {
          exports.stop();
        } catch {
          // Best effort.
        }
      }
      this.instance = null;
    }
    this.log(`[wasm-sidecar] stopped ${this.wasmPath}`);
  }
}
