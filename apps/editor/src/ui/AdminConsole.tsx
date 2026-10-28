/**
 * Admin Console panel (EA1 Admin Console feature branch).
 * Exposes server diagnostics, admin actions, and system management controls.
 */

import * as React from "react";
import { fetchAdminStatus, runAdminAction, type AdminStatus } from "../api/admin.js";
import { MIcon } from "./components.js";

export function AdminConsole(): React.JSX.Element {
  const [status, setStatus] = React.useState<AdminStatus | null>(null);
  const [loading, setLoading] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  const loadStatus = React.useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchAdminStatus();
      setStatus(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadStatus();
    const interval = setInterval(() => void loadStatus(), 10000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  const handleAction = async (action: string) => {
    try {
      setMessage(null);
      setError(null);
      const res = await runAdminAction(action);
      setMessage(`Action ${action}: ${res.message ?? "success"}`);
      void loadStatus();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 text-[13px]" data-testid="admin-console">
      <div className="flex items-center justify-between border-b pb-2">
        <div className="flex items-center gap-2 font-medium">
          <span aria-hidden="true">⚙️</span>
          <span>Admin Console</span>
        </div>
        <button
          onClick={() => void loadStatus()}
          className="rounded px-2 py-1 text-xs font-medium hover:bg-surface-variant transition-colors"
          style={{ background: "var(--m3-surface-2)", color: "var(--m3-on-surface)" }}
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded p-2 text-xs" style={{ background: "var(--m3-error-container)", color: "var(--m3-on-error-container)" }}>
          Error: {error}
        </div>
      )}

      {message && (
        <div className="rounded p-2 text-xs" style={{ background: "var(--m3-primary-container)", color: "var(--m3-on-primary-container)" }}>
          {message}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 rounded-lg p-2.5" style={{ background: "var(--m3-surface-2)" }}>
        <div className="flex flex-col">
          <span className="text-[11px] text-muted-foreground">Server Status</span>
          <span className="font-semibold" style={{ color: status?.running ? "var(--m3-primary)" : "var(--m3-error)" }}>
            {status?.running ? "Running" : "Stopped / Offline"}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[11px] text-muted-foreground">Uptime</span>
          <span className="font-mono">{status ? `${Math.floor(status.uptime)}s` : "—"}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[11px] text-muted-foreground">Memory Usage</span>
          <span className="font-mono">{status ? `${Math.round(status.memoryUsage / 1024 / 1024)} MB` : "—"}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[11px] text-muted-foreground">Active Sessions</span>
          <span className="font-mono">{status?.activeSessions ?? 0}</span>
        </div>
      </div>

      <div className="flex flex-col gap-2 mt-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Admin Actions</h3>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void handleAction("restart")}
            className="flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors"
            style={{ background: "var(--m3-surface-variant)", color: "var(--m3-on-surface-variant)" }}
          >
            <MIcon name="refresh" size={14} />
            Restart Server
          </button>
          <button
            onClick={() => void handleAction("clear-cache")}
            className="flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors"
            style={{ background: "var(--m3-surface-variant)", color: "var(--m3-on-surface-variant)" }}
          >
            <MIcon name="delete" size={14} />
            Clear Caches
          </button>
          <button
            onClick={() => void handleAction("health-check")}
            className="flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors"
            style={{ background: "var(--m3-surface-variant)", color: "var(--m3-on-surface-variant)" }}
          >
            <MIcon name="check_circle" size={14} />
            Run Diagnostics
          </button>
        </div>
      </div>
    </div>
  );
}
