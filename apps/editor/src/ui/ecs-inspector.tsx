/**
 * ECS inspector panel — read-only browser over authoritative entities.
 *
 * Connects to any running server (including the one play mode starts),
 * lists entities with text + component filtering, and projects the
 * selected entity's component rows. All rendering goes through the
 * EcsInspector view-model (src/inspectors/ecs.ts); this component only
 * wires the live MirrorClient into it and draws the result.
 *
 * There is deliberately no edit path: the view-model exposes no
 * mutation API, and the panel renders none.
 */

import * as React from "react";
import type { MirrorClient } from "@mmo-engine/mirror";
import { EcsInspector, type ComponentKind } from "../inspectors/ecs.js";
import { connectMirror } from "./mirror-connect.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  KvTable,
  Label,
  SectionTitle,
} from "./components.js";
import { editorSelection } from "./editor-selection.js";

const ALL_COMPONENTS: ComponentKind[] = [
  "transform",
  "velocity",
  "intent",
  "chunk",
  "health",
  "body",
];

const DEFAULT_URL =
  typeof window !== "undefined" && window.location.hostname
    ? `ws://${window.location.hostname}:7777`
    : "ws://127.0.0.1:7777";

export function EcsInspectorPanel(): React.JSX.Element {
  const [url, setUrl] = React.useState(DEFAULT_URL);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [client, setClient] = React.useState<MirrorClient | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [connecting, setConnecting] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [compFilter, setCompFilter] = React.useState<ComponentKind[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [, setVersion] = React.useState(0);

  const inspectorRef = React.useRef<EcsInspector | null>(null);
  const clientRef = React.useRef<MirrorClient | null>(null);
  clientRef.current = client;
  if (!inspectorRef.current) {
    inspectorRef.current = new EcsInspector(() => {
      const c = clientRef.current;
      return {
        tick: c?.serverTick ?? 0,
        entities: c?.state.entities ?? new Map(),
      };
    });
  }
  const inspector = inspectorRef.current;

  const bump = React.useCallback(() => setVersion((v) => v + 1), []);

  async function onConnect(): Promise<void> {
    if (!username) {
      setError("Enter the dev username (server users come from MMO_DEV_PASSWORD setup).");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const c = await connectMirror(
        url,
        "mmo-editor-ecs",
        { username, password },
        bump,
      );
      setClient(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }

  function onDisconnect(): void {
    client?.disconnect();
    setClient(null);
    setSelected(null);
    editorSelection.clear("entity-list");
  }

  // Poll while connected so the list stays fresh even between deltas.
  React.useEffect(() => {
    if (!client) return;
    const t = setInterval(bump, 1000);
    return () => clearInterval(t);
  }, [client, bump]);

  function toggleComponent(k: ComponentKind): void {
    setCompFilter((prev) =>
      prev.includes(k) ? prev.filter((c) => c !== k) : [...prev, k],
    );
  }

  const rows = client
    ? inspector.listEntities({
        text: search || undefined,
        components: compFilter.length ? compFilter : undefined,
      })
    : [];
  const detail = selected ? inspector.getEntity(selected) : undefined;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>ECS Inspector</CardTitle>
            <div className="flex items-center gap-2">
              {client ? (
                <Badge tone="ok">connected · tick {inspector.getTick()}</Badge>
              ) : (
                <Badge tone="warn">disconnected</Badge>
              )}
              <Badge tone="info">{inspector.getEntityCount()} entities</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!client ? (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_160px_160px_auto] gap-2">
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="ws://127.0.0.1:7777"
                  aria-label="Server URL"
                />
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="username"
                  aria-label="Username"
                  autoComplete="username"
                />
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="password"
                  aria-label="Password"
                  autoComplete="current-password"
                />
                <Button onClick={onConnect} disabled={connecting}>
                  {connecting ? "Connecting…" : "Connect"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Connects to any running server — including the one Play Mode
                starts. Credentials are the server's dev users
                (MMO_DEV_PASSWORD setup); a session token also works via the
                game client.
              </p>
              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Mirroring <span className="font-mono">{url}</span> — snapshots
                + 30 Hz deltas, exactly like the game client.
              </p>
              <Button variant="outline" size="sm" onClick={onDisconnect}>
                Disconnect
              </Button>
            </div>
          )}

          <div className="rounded-md border border-yellow-900 bg-yellow-950/40 p-3 text-xs text-yellow-200">
            <span className="font-semibold">Read-only. </span>
            {inspector.readonlyNotice}
          </div>

          {client && (
            <>
              <div className="flex flex-col gap-2">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by wire id…"
                  aria-label="Filter entities"
                />
                <div className="flex flex-wrap gap-1.5">
                  {ALL_COMPONENTS.map((k) => (
                    <button
                      key={k}
                      onClick={() => toggleComponent(k)}
                      className={
                        "rounded-full border px-2.5 py-1 text-xs " +
                        (compFilter.includes(k)
                          ? "border-primary bg-primary/20 text-primary-foreground"
                          : "border-input text-muted-foreground hover:bg-accent")
                      }
                    >
                      {k}
                    </button>
                  ))}
                  {compFilter.length > 0 && (
                    <button
                      onClick={() => setCompFilter([])}
                      className="rounded-full px-2.5 py-1 text-xs text-muted-foreground underline"
                    >
                      clear
                    </button>
                  )}
                </div>
              </div>

              <div className="max-h-[420px] overflow-y-auto rounded-md border border-border">
                {rows.length === 0 && (
                  <p className="p-4 text-xs text-muted-foreground">
                    No entities match.
                  </p>
                )}
                {rows.slice(0, 300).map((r) => (
                  <button
                    key={r.wireId}
                    onClick={() => {
                      setSelected(r.wireId);
                      editorSelection.select({
                        source: "entity-list",
                        kind: "entity",
                        id: r.wireId,
                        label: r.label,
                        components: (inspector.getEntity(r.wireId) ?? []).map((component) => ({
                          name: component.component,
                          fields: component.fields,
                        })),
                      });
                    }}
                    className={
                      "flex w-full items-center justify-between gap-2 border-b border-border/50 px-3 py-1.5 text-left text-xs hover:bg-accent " +
                      (selected === r.wireId ? "bg-accent" : "")
                    }
                  >
                    <span className="font-mono">{r.label}</span>
                    <span className="flex gap-1">
                      {r.components.map((c) => (
                        <Badge key={c} tone="default">
                          {c}
                        </Badge>
                      ))}
                    </span>
                  </button>
                ))}
                {rows.length > 300 && (
                  <p className="p-2 text-center text-xs text-muted-foreground">
                    …{rows.length - 300} more (refine the filter)
                  </p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Entity detail</CardTitle>
        </CardHeader>
        <CardContent>
          {!selected || !detail ? (
            <p className="text-xs text-muted-foreground">
              Select an entity to inspect its component rows.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <Label>Wire id</Label>
                <p className="font-mono text-sm">{selected}</p>
              </div>
              {detail.map((d) => (
                <div key={d.component}>
                  <SectionTitle>{d.component}</SectionTitle>
                  <div className="mt-1">
                    <KvTable rows={d.fields} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
