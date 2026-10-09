/**
 * Base worker class with plugin architecture for task handlers.
 * Handles message routing, transferable buffers, error handling, and retries.
 */
import type { TaskPayloadMap, WorkerResponse, WorkerTaskHandler } from './types.js';

/** The slice of a worker's global scope the runtime uses; injectable for tests. */
export interface WorkerScope {
  onmessage: ((e: any) => any) | null;
  onerror: ((e: any) => any) | null;
  postMessage(message: any, transfer?: Transferable[]): void;
  addEventListener(type: string, fn: (e: any) => void): void;
  removeEventListener(type: string, fn: (e: any) => void): void;
}

export interface WorkerConfig {
  maxRetries: number;
  retryDelayMs: number;
  maxConcurrentTasks: number;
}

export class WorkerRuntime {
  private handlers = new Map<string, WorkerTaskHandler<any>>();
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private taskIdCounter = 0;
  private running = 0;
  private waiting: Array<() => void> = [];
  private config: WorkerConfig;

  constructor(config: Partial<WorkerConfig> = {}, private scope: WorkerScope = self as unknown as WorkerScope) {
    this.config = {
      maxRetries: 3,
      retryDelayMs: 1000,
      maxConcurrentTasks: 4,
      ...config,
    };

    this.scope.onmessage = this.onMessage.bind(this);
    this.scope.onerror = this.onError.bind(this);
  }

  /** Register a task handler. Can be called multiple times to add/override handlers. */
  registerHandler(type: string, handler: WorkerTaskHandler<any>) {
    this.handlers.set(type, handler);
  }

  /** Send a request to the worker and await the response. */
  async request<T extends keyof TaskPayloadMap>(
    type: T,
    payload: TaskPayloadMap[T]
  ): Promise<WorkerResponse<T>['payload']> {
    const id = ++this.taskIdCounter;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.scope.postMessage({ id, type, payload } as any, WorkerRuntime.getTransferables(payload));
    });
  }

  /** Post a message to the main thread. */
  protected postMessage(message: any, transfer?: Transferable[]) {
    this.scope.postMessage(message, transfer);
  }

  private onMessage = async (e: MessageEvent) => {
    const msg = e.data as { id: number; type: string; payload: any };
    if (!msg?.id || !msg.type) return;

        // Main thread -> worker request
    if (!this.pending.has(msg.id)) {
      await this.handleTask(msg.id, msg.type, msg.payload);
      return;
    }

    // Worker -> main thread response
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);

    if (msg.payload?.error) {
      pending.reject(new Error(msg.payload.error));
    } else {
      pending.resolve(msg.payload);
    }
  };

  private onError = (event: ErrorEvent) => {
    console.error('[Worker] Unhandled error:', event.error || event.message);
  };

  /** Runs at most maxConcurrentTasks tasks at once; the rest wait in arrival order. */
  private async handleTask(id: number, type: string, payload: any) {
    if (this.running >= this.config.maxConcurrentTasks) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      await this.runTask(id, type, payload);
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private async runTask(id: number, type: string, payload: any) {
    const handler = this.handlers.get(type);
    if (!handler) {
      this.postError(id, type, `No handler for task type: ${type}`);
      return;
    }

    let attempt = 0;
    while (attempt <= this.config.maxRetries) {
      try {
        const result = await handler.handle(payload);
        this.scope.postMessage({ id, type, payload: result }, WorkerRuntime.getTransferables(result));
        return;
      } catch (err) {
        attempt++;
        if (attempt > this.config.maxRetries) {
          this.postError(id, type, (err as Error).message);
          return;
        }
        await this.sleep(this.config.retryDelayMs * attempt);
      }
    }
  }

  private postError(id: number, type: string, error: string) {
    this.scope.postMessage({ id, type, payload: { error } });
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Send a request from worker to main thread (for callbacks, notifications, etc.) */
  async callMainThread(payload: { id: number; [k: string]: any }): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);
      const handler = (e: MessageEvent) => {
        const msg = e.data;
        if (msg.id === payload.id && msg.type === 'callback') {
          clearTimeout(timeout);
          this.scope.removeEventListener('message', handler);
          if (msg.payload?.error) reject(new Error(msg.payload.error));
          else resolve(msg.payload);
        }
      };
      this.scope.addEventListener('message', handler);
      this.scope.postMessage({ type: 'callback', payload });
    });
  }

  /** Helper to create transferable buffer list from result payload */
  static getTransferables(payload: any): Transferable[] {
    const buffers: Transferable[] = [];
    const seen = new Set<ArrayBufferLike>();

    function add(buf: ArrayBufferLike | null | undefined) {
      if (buf && !seen.has(buf)) {
        seen.add(buf);
        buffers.push(buf as ArrayBuffer);
      }
    }

    function walk(obj: any) {
      if (!obj || typeof obj !== 'object') return;
      if (obj instanceof ArrayBuffer) {
        add(obj);
      } else if (ArrayBuffer.isView(obj)) {
        add(obj.buffer);
      } else if (Array.isArray(obj)) {
        obj.forEach(walk);
      } else {
        Object.values(obj).forEach(walk);
      }
    }

    walk(payload);
    return buffers;
  }
}