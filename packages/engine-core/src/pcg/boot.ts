/**
 * Region boot for PCG assets: load the asset library, load the native cook
 * (optional: without it, assets are listed but clients keep their
 * placeholder shapes), and serve the Pcg webrpc service on the gateway's
 * port, authenticated by the gateway's session tokens.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Gateway } from "../net/gateway.js";
import { RpcServer } from "../net/rpc-http.js";
import { PcgAssetLibrary, type PcgCooker } from "./asset-library.js";
import { registerPcgRpc } from "./pcg-rpc.js";

/** The repo's asset library (dist/src/pcg -> repo root). */
export const DEFAULT_PCG_ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../content/pcg");

/** The native cooker, or null (with the reason) when the addon isn't built. */
export function loadNativeCooker(): { cooker: PcgCooker | null; version: string; error?: string } {
  try {
    const require = createRequire(import.meta.url);
    const addon = require("@mmo-engine/addon-picg") as PcgCooker & { version(): string };
    return { cooker: addon, version: addon.version() };
  } catch (err) {
    return { cooker: null, version: "", error: (err as Error).message.split("\n")[0] };
  }
}

export interface PcgService {
  library: PcgAssetLibrary;
  rpc: RpcServer;
  /** One line for the boot log. */
  summary: string;
}

/**
 * Mount the Pcg service on the gateway (call before gw.listen()). Null when
 * there is no library at `dir` — PCG assets are optional.
 */
export function startPcgService(gw: Gateway, dir = DEFAULT_PCG_ASSETS, cooker = loadNativeCooker()): PcgService | null {
  if (!existsSync(path.join(dir, "index.json"))) return null;
  const library = PcgAssetLibrary.load(dir, cooker.cooker);
  const rpc = new RpcServer({ authenticate: (token) => gw.sessionUser(token) });
  registerPcgRpc(rpc, library);
  // Compose with whatever handler is already mounted (e.g. /health):
  // the first handler to claim the request wins.
  const prev = gw.getHttpHandler();
  gw.setHttpHandler((req, res) => (prev ? prev(req, res) : false) || rpc.handle(req, res));
  const assets = library.list();
  const summary =
    `${assets.length} PCG asset(s) (${assets.map((a) => a.id).join(", ")}) from ${dir}; ` +
    (cooker.cooker ? `cooking with ${cooker.version}` : `NOT cooking (${cooker.error ?? "no addon"})`);
  return { library, rpc, summary };
}
