/**
 * Admin API client and host functions for the editor admin console.
 */
import { requestJson } from "../api.js";

export interface AdminStatus {
  running: boolean;
  uptime: number;
  memoryUsage: number;
  activeSessions: number;
}

export async function fetchAdminStatus(): Promise<AdminStatus> {
  return requestJson<AdminStatus>("/api/editor/admin/status", {
    fail: "Could not fetch admin status",
  });
}

export async function runAdminAction(action: string, payload?: unknown): Promise<{ ok: boolean; message?: string }> {
  return requestJson<{ ok: boolean; message?: string }>("/api/editor/admin/action", {
    method: "POST",
    body: { action, payload },
    fail: `Could not execute admin action ${action}`,
  });
}
