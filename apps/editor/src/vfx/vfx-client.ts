/**
 * Browser-safe adapter for the Particle panel: the dev host's `/api/editor/vfx`
 * routes. The host validates a save; a refusal comes back as an Error naming
 * every problem.
 */
import { callEnvelope } from "../api.js";

const call = <T>(method: "GET" | "POST" | "PUT", route: string, body?: unknown): Promise<T> =>
  callEnvelope<T>(`/api/editor/vfx${route}`, method, body);

/** List effect ids in content/vfx/. */
export const listEffects = async (): Promise<string[]> =>
  (await call<{ effects: string[] }>("GET", "/effects")).effects;

/** Load an effect's raw JSON document. */
export const getEffect = async (id: string): Promise<unknown> =>
  (await call<{ content: unknown }>("GET", `/effects/${encodeURIComponent(id)}`)).content;

/** Validate on the host and write only when valid. */
export const saveEffect = (id: string, content: unknown): Promise<unknown> =>
  call("PUT", `/effects/${encodeURIComponent(id)}`, { content });
