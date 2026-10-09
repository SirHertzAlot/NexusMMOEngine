/** Main-thread side: a few workers, each request to the least busy one. */
import { WorkerRuntime, type WorkerScope } from './runtime.js';
import type { TaskPayloadMap, WorkerResponse } from './types.js';

export interface WorkerRequester {
  request<T extends keyof TaskPayloadMap>(type: T, payload: TaskPayloadMap[T]): Promise<WorkerResponse<T>['payload']>;
}

export class WorkerPool implements WorkerRequester {
  private readonly slots: Array<{ rt: WorkerRuntime; scope: WorkerScope; busy: number }>;

  constructor(make: () => WorkerScope, size: number) {
    this.slots = Array.from({ length: Math.max(1, size) }, () => {
      const scope = make();
      return { rt: new WorkerRuntime({}, scope), scope, busy: 0 };
    });
  }

  /** Stop the workers (a real Worker has terminate()). */
  dispose(): void {
    for (const s of this.slots) (s.scope as { terminate?: () => void }).terminate?.();
  }

  async request<T extends keyof TaskPayloadMap>(type: T, payload: TaskPayloadMap[T]): Promise<WorkerResponse<T>['payload']> {
    const slot = this.slots.reduce((a, b) => (b.busy < a.busy ? b : a));
    slot.busy++;
    try {
      return await slot.rt.request(type, payload);
    } finally {
      slot.busy--;
    }
  }
}
