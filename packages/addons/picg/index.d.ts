/** A cooked graph: a PCGM mesh (see @mmo-engine/picg decodeMesh), JSON (points/splines), or nothing. */
export type CookResult =
  | { kind: "mesh"; mesh: ArrayBuffer; vertexCount: number; indexCount: number }
  | { kind: "json"; json: string }
  | { kind: "none" };

/** pcg-core runtime version. */
export function version(): string;
/** Null when the graph is valid, else pcg-core's message. */
export function validate(graph: string | object): string | null;
/** Cook a flattened `.pcg` graph off the calling thread (one cook at a time). */
export function cook(graph: string | object, seed?: number): Promise<CookResult>;
/** Drop pcg-core's per-node cook cache. */
export function clearCache(): void;
