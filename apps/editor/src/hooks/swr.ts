/**
 * SWR hooks for editor-side data fetching with deduplication and caching.
 * Replaces manual fetch + useEffect patterns.
 */
import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : null));

/** Generic SWR hook for JSON endpoints. */
export function useJson<T>(url: string, options?: { revalidateOnFocus?: boolean; dedupingInterval?: number }) {
  return useSWR<T>(url, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
    ...options,
  });
}

/** SWR hook for admin endpoints with short deduping for polling. */
export function useAdminJson<T>(url: string, refreshInterval = 2000) {
  return useSWR<T>(url, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: refreshInterval,
    refreshInterval,
  });
}

/** SWR hook for admin commands that need to be triggered manually. */
export function useAdminCommand<T>(url: string) {
  return useSWR<T>(url, fetcher, {
    revalidateOnFocus: false,
    revalidateOnMount: false, // Only fetch when triggered
    revalidateIfStale: false,
  });
}