/**
 * Ask a panel to open a specific asset (from the command palette).
 * Panels subscribe for the kinds they open; the palette publishes. The
 * payload is the catalog entry's kind and id.
 *
 * Picking an asset usually switches workspace first, so the panel that
 * opens it mounts after the request. A request nobody takes waits (the
 * latest one per kind) and goes to the first panel that subscribes for
 * its kind.
 */

export interface OpenAssetRequest {
  kind: string;
  id: string;
}

interface Listener {
  kinds: ReadonlySet<string> | null;
  fn: (req: OpenAssetRequest) => void;
}

const listeners = new Set<Listener>();
const pending = new Map<string, OpenAssetRequest>();

const takes = (l: Listener, kind: string): boolean => l.kinds === null || l.kinds.has(kind);

export function requestOpenAsset(kind: string, id: string): void {
  const req = { kind, id };
  let taken = false;
  for (const l of listeners) {
    if (!takes(l, kind)) continue;
    taken = true;
    l.fn(req);
  }
  if (taken) pending.delete(kind);
  else pending.set(kind, req);
}

/** Listen for open requests of `kinds` (all kinds when omitted); a waiting request is delivered now. */
export function subscribeOpenAsset(fn: (req: OpenAssetRequest) => void, kinds?: readonly string[]): () => void {
  const l: Listener = { kinds: kinds ? new Set(kinds) : null, fn };
  listeners.add(l);
  for (const [kind, req] of [...pending]) {
    if (!takes(l, kind)) continue;
    pending.delete(kind);
    fn(req);
  }
  return () => {
    listeners.delete(l);
  };
}

/** For tests: the request waiting for a panel of `kind`, if any. */
export function pendingOpenAsset(kind: string): OpenAssetRequest | undefined {
  return pending.get(kind);
}
