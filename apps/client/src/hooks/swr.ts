/**
 * SWR hooks for client-side data fetching with deduplication and caching.
 * Replaces manual fetch + useEffect patterns.
 */
import useSWR from "swr";
import type { HudLayout } from "../ui/hud-layout";

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : null));

/** Fetch hud.json with SWR deduplication (60s deduping interval). Returns the data directly. */
export function useHudJson(url = "/content/ui/hud.json"): HudLayout | null {
  const { data } = useSWR<HudLayout | null>(url, fetcher, { revalidateOnFocus: false, dedupingInterval: 60_000, fallbackData: null });
  return data ?? null;
}

/** Generic SWR hook for JSON endpoints. Returns the data directly. */
export function useJson<T>(url: string, options?: { revalidateOnFocus?: boolean; dedupingInterval?: number }): T | undefined {
  const { data } = useSWR<T>(url, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
    ...options,
  });
  return data;
}

/** Generic SWR hook for admin endpoints with shorter deduping. Returns the data directly. */
export function useAdminJson<T>(url: string): T | undefined {
  const { data } = useSWR<T>(url, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 2_000, // 2s for admin polling
  });
  return data;
}