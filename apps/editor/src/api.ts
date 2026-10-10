/**
 * The one HTTP layer of the editor: every `*-client.ts` talks to the dev
 * host through `requestJson`, and every `*-host.ts` refuses an invalid
 * document through `refuseInvalid`, so a failed save looks the same
 * everywhere (a 400 with the issues, which the client turns back into an
 * `IssuesError` subclass the panel can catch by type).
 *
 * Browser-safe: only `fetch` and plain objects.
 */

/** "invalid flow: 2 problems". */
export const invalidMessage = (noun: string, count: number): string => `invalid ${noun}: ${count} problem${count === 1 ? "" : "s"}`;

/**
 * The host's refusal of an invalid document: status 400 with every issue.
 * `count` is how many problems to name (a story's warnings do not count).
 */
export function refuseInvalid(noun: string, issues: readonly unknown[], count = issues.length): Error {
  return Object.assign(new Error(invalidMessage(noun, count)), { status: 400, issues });
}

/**
 * A refused save, with every problem. Each document type extends it, so a
 * panel catches `e instanceof SceneSaveError` and reads `e.issues`.
 */
export class IssuesError<I> extends Error {
  constructor(readonly issues: I[], message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  /** Sent as JSON; omit for no body. */
  body?: unknown;
  /** The message when the host gives none: "<fail>: HTTP 500". */
  fail: string;
  /** Turns a 400's issues into the document's own error. */
  refused?: (issues: any[]) => Error;
}

/** The host's failure for `res`: its issues, else its `error` text, else `<fail>: HTTP <status>`. */
async function failure(res: Response, opts: Pick<RequestOptions, "fail" | "refused">): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: unknown; issues?: unknown };
    if (res.status === 400 && Array.isArray(body.issues) && opts.refused) return opts.refused(body.issues);
    if (typeof body.error === "string" && body.error) return new Error(body.error);
  } catch {
    /* no JSON body: fall through */
  }
  return new Error(`${opts.fail}: HTTP ${res.status}`);
}

/** One JSON call to the dev host. Resolves the parsed body (undefined when empty); rejects with `failure`. */
export async function requestJson<T = void>(url: string, opts: RequestOptions): Promise<T> {
  const res = await fetch(url, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    ...(opts.body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.body) }),
  });
  if (!res.ok) throw await failure(res, opts);
  // A save answers with a small body or none; an empty or non-JSON success reads as undefined.
  return (await res.json().catch(() => undefined)) as T;
}

/**
 * The `{ ok, error }` envelope the database and version-control routes
 * answer with: a 200 can still say `ok: false`. `refused` turns a 400's
 * issues into the document's own error.
 */
export async function callEnvelope<T>(url: string, method: "GET" | "POST" | "PUT", body?: unknown, refused?: (issues: any[]) => Error): Promise<T> {
  const res = await fetch(url, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string; issues?: unknown };
  // A refused document (400 with its issues) becomes the document's own error, as in `requestJson`.
  if (res.status === 400 && refused && Array.isArray(json.issues)) throw refused(json.issues);
  // The whole answer rides on the error, so a panel can read the host's issues.
  if (!res.ok || json.ok === false) throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { body: json });
  return json;
}

// --- Host side: the routes' shared plumbing -----------------------------------

/** What a `handle*Route` answers. */
export interface RouteReply {
  status: number;
  body: unknown;
}

/** The field `key` of a PUT/POST body that must be a JSON object; a 400 (thrown) names what was wrong. */
export function jsonBodyField(body: string | undefined, key: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? "") as unknown;
  } catch {
    throw Object.assign(new Error("request body is not valid JSON"), { status: 400 });
  }
  if (typeof parsed !== "object" || parsed === null || !(key in parsed)) {
    throw Object.assign(new Error(`need a JSON body shaped like {"${key}": …}`), { status: 400 });
  }
  return (parsed as Record<string, unknown>)[key];
}

/** A thrown error as the host's `{ ok: false, error, issues? }` answer (see `refuseInvalid`). */
export function failureReply(err: unknown): RouteReply {
  const e = err as { status?: number; issues?: unknown };
  return {
    status: e.status ?? 500,
    body: { ok: false, error: err instanceof Error ? err.message : String(err), ...(Array.isArray(e.issues) ? { issues: e.issues } : {}) },
  };
}
