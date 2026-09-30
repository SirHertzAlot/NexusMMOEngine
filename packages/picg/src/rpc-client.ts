/**
 * Client for the region's Pcg webrpc service (engine-core pcg.ridl), for
 * the browser client and the editor: POST /rpc/Pcg/<Method> with the
 * gateway session token as Bearer, JSON in and out, webrpc `{code, msg}`
 * errors thrown as PcgRpcError.
 */

export interface PcgAssetInfo {
  id: string;
  assetHash: number;
  displayName: string;
  graph: string;
  variants: number;
  revision: number;
}

export interface PcgMeshRef {
  assetHash: number;
  variantIndex: number;
  revision: number;
  /** Server path of the PCGM bytes; empty when the asset has no mesh. */
  url: string;
  vertexCount: number;
  triangleCount: number;
  /** Simplified levels, most detailed first (servers without meshoptimizer send none). */
  lods?: Array<{ url: string; vertexCount: number; triangleCount: number; error: number }>;
}

export class PcgRpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "PcgRpcError";
  }
}

/** The region's HTTP base for its game WebSocket URL (same port). */
export function httpBaseForGameUrl(gameUrl: string): string {
  return gameUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
}

export class PcgRpcClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: () => string | null,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async call<T>(method: string, args: object = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/rpc/Pcg/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.auth() },
      body: JSON.stringify(args),
    });
    const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
    if (!res.ok) throw new PcgRpcError(body.code ?? res.status, body.msg ?? res.statusText);
    return body as T;
  }

  async listAssets(): Promise<PcgAssetInfo[]> {
    return (await this.call<{ assets: PcgAssetInfo[] }>("ListAssets")).assets;
  }

  async getAssetMesh(assetHash: number, variant: number): Promise<PcgMeshRef> {
    return (await this.call<{ mesh: PcgMeshRef }>("GetAssetMesh", { assetHash: assetHash >>> 0, variant: variant & 0xffff })).mesh;
  }

  /** The PCGM bytes a mesh ref (or one of its levels, `{ url }`) points at. */
  async download(ref: { url: string }): Promise<ArrayBuffer> {
    const res = await this.fetchImpl(this.baseUrl + ref.url, { headers: this.auth() });
    if (!res.ok) throw new PcgRpcError(res.status, `mesh download failed (${res.status})`);
    return res.arrayBuffer();
  }

  private auth(): Record<string, string> {
    const t = this.token();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }
}
