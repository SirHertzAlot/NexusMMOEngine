/**
 * The shared "is the server there?" gate for panels that need the running
 * play-mode server (Live ops, Network). With no server it says so and
 * offers Start (the host's existing start route); with one it renders its
 * children. The one ServerLink is polled while any gated panel is mounted.
 */
import * as React from "react";
import { ServerLink, browserDeps, type LinkState } from "../server-link.js";
import { Button, EmptyState } from "./components.js";

export const serverLink = new ServerLink(browserDeps());

const POLL_MS = 3000;
let mounted = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function acquire(): () => void {
  mounted += 1;
  if (mounted === 1) {
    void serverLink.refresh();
    timer = setInterval(() => void serverLink.refresh(), POLL_MS);
  }
  return () => {
    mounted -= 1;
    if (mounted === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The link's state, polling the host while the calling component is mounted. */
export function useServerLink(): LinkState {
  React.useEffect(acquire, []);
  return React.useSyncExternalStore(
    (fn) => serverLink.subscribe(fn),
    () => serverLink.get(),
  );
}

export function ServerGate({ what, children }: { what: string; children: (s: LinkState) => React.ReactNode }): React.JSX.Element {
  const s = useServerLink();
  if (s.phase === "live") return <>{children(s)}</>;
  const starting = s.phase === "starting" || s.phase === "connecting";
  return (
    <EmptyState
      icon={s.phase === "error" ? "error" : "dns"}
      title={s.phase === "error" ? "Cannot reach the server" : starting ? "Starting the server…" : "Server not running"}
      body={s.phase === "error" ? (s.error ?? "unknown error") : `${what} needs the running play-mode server. Start it here, or press Play.`}
      action={
        <Button size="sm" disabled={starting} onClick={() => void serverLink.start()}>
          {starting ? "Starting…" : s.phase === "error" ? "Start again" : "Start server"}
        </Button>
      }
    />
  );
}
