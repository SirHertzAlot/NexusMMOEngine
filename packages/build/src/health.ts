/**
 * Health check for a local (or staging) target: GET the /health URL,
 * true only on HTTP 200 within the timeout. Network errors, non-200
 * statuses and timeouts are all "not healthy" — the caller decides
 * whether to roll back.
 */

export async function checkHealth(url: string, timeoutMs = 5000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
