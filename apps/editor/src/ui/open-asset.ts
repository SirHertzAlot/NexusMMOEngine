/**
 * Ask a panel to open a specific asset (from the command palette).
 * Panels subscribe; the palette publishes. The payload is the catalog
 * entry's kind and id.
 */

export interface OpenAssetRequest {
  kind: string;
  id: string;
}

const listeners = new Set<(req: OpenAssetRequest) => void>();

export function requestOpenAsset(kind: string, id: string): void {
  const req = { kind, id };
  listeners.forEach((fn) => fn(req));
}

export function subscribeOpenAsset(fn: (req: OpenAssetRequest) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
