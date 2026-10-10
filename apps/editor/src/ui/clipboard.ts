/**
 * In-memory editor clipboard for document nodes (scene nodes, flow nodes…).
 *
 * A single slot holding a JSON-serializable value plus the kind that wrote
 * it ("scene-node", …). Panels copy to it and paste from it; pasting into
 * a different kind is refused. In-memory (not the OS clipboard): no
 * permissions prompts, and node structures survive intact.
 */

export interface ClipboardValue {
  kind: string;
  data: unknown;
}

let slot: ClipboardValue | null = null;
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  listeners.forEach((fn) => fn());
}

export function writeClipboard(kind: string, data: unknown): void {
  // Structured clone so later edits to the document don't mutate the copy.
  slot = { kind, data: structuredClone(data) };
  emit();
}

export function readClipboard(kind: string): unknown | null {
  if (!slot || slot.kind !== kind) return null;
  return structuredClone(slot.data);
}

export function clearClipboard(): void {
  slot = null;
  emit();
}

/** Subscribe to clipboard changes (menus refresh Paste state). */
export function subscribeClipboard(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Snapshot for useSyncExternalStore. */
export function clipboardVersion(): number {
  return version;
}

/** For tests. */
export function peekClipboard(): ClipboardValue | null {
  return slot;
}
