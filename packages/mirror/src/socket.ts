/**
 * Socket abstraction for the mirror client.
 *
 * The browser's native WebSocket is the production transport; tests
 * inject a fake. Keeping the client behind this narrow interface (SOLID)
 * means the protocol logic in client.ts never touches the DOM and is
 * fully unit-testable in Node.
 */

export interface SocketLike {
  send(data: Uint8Array): void;
  close(): void;
  onmessage: ((data: Uint8Array) => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
  onopen: (() => void) | null;
}

/**
 * Browser WebSocket adapter. `binaryType = "arraybuffer"` so frames
 * arrive as ArrayBuffers; they are copied into Uint8Arrays at the
 * boundary (the only per-frame allocation, outside the hot path).
 */
export class BrowserSocket implements SocketLike {
  onmessage: ((data: Uint8Array) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onopen: (() => void) | null = null;

  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => this.onopen?.();
    this.ws.onmessage = (ev: MessageEvent) => {
      const data = ev.data;
      if (data instanceof ArrayBuffer) {
        this.onmessage?.(new Uint8Array(data));
      } else if (typeof data === "string") {
        this.onmessage?.(new TextEncoder().encode(data));
      }
    };
    this.ws.onclose = () => this.onclose?.();
    this.ws.onerror = (ev) => this.onerror?.(ev);
  }

  send(data: Uint8Array): void {
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }
}
