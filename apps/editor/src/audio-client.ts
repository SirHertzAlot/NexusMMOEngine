/**
 * Browser-safe adapter for the Audio panel: the dev host's `/api/editor/audio`
 * routes (audio-host.ts). The host validates a save with the server's own
 * schema; a refusal comes back as an Error naming every problem.
 */
import { callEnvelope } from "./api.js";

const call = <T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> => callEnvelope<T>(`/api/editor/audio${route}`, method, body);

/** The raw document (`buses` and `events`); the panel reads it with the client's parseAudioBank. */
export const getAudio = async (): Promise<unknown> => (await call<{ content: unknown }>("GET", "")).content;

/** Validate on the host and write only when valid. */
export const saveAudio = (content: unknown): Promise<unknown> => call("POST", "/save", { content });
