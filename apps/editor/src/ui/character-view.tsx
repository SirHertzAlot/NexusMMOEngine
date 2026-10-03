/**
 * Character record panel — read-only view over one account's character.
 *
 * Picks a character (by account username, then character) and shows its
 * name, look (canonical JSON, summarized), deaths, saved state and ledger
 * items. All data comes from the dev host's read-only character routes
 * (characters.db + world.db opened read-only); this panel has no edit
 * path, like the ECS inspector.
 */

import * as React from "react";
import {
  getCharacterRecord,
  listCharacterRecords,
  type CharacterView,
} from "../character-records.js";
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

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(ms) : d.toLocaleString();
}

function fmtNum(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(n);
}

export function CharacterRecordPanel(): React.JSX.Element {
  const [username, setUsername] = React.useState("");
  const [entries, setEntries] = React.useState<Array<{ id: number; username: string; name: string }>>([]);
  const [hasDb, setHasDb] = React.useState(true);
  const [listed, setListed] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [view, setView] = React.useState<CharacterView | null>(null);
  const [defsResolved, setDefsResolved] = React.useState(false);
  const [hasWorldDb, setHasWorldDb] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onList(): Promise<void> {
    setLoading(true);
    setError(null);
    setView(null);
    setSelectedId(null);
    try {
      const res = await listCharacterRecords("", username.trim() || undefined);
      setEntries(res.characters);
      setHasDb(res.hasDb);
      setListed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function onSelect(id: number): Promise<void> {
    const name = username.trim();
    if (!name) {
      setError("Enter the account username first — a record belongs to an account's character.");
      return;
    }
    setSelectedId(id);
    setLoading(true);
    setError(null);
    try {
      const res = await getCharacterRecord("", name, id);
      setView(res.view);
      setDefsResolved(res.defsResolved);
      setHasWorldDb(res.hasWorldDb);
    } catch (err) {
      setView(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Characters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div>
            <Label>Account username</Label>
            <div className="mt-1 flex gap-2">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="alice (empty: everyone)"
                aria-label="Account username"
              />
              <Button onClick={onList} disabled={loading}>
                {loading ? "Loading…" : "List"}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Reads the editor world&apos;s characters.db (read-only). Leave
              empty to list every account&apos;s characters.
            </p>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          {listed && !hasDb && (
            <p className="text-xs text-muted-foreground">
              No characters.db yet — create a character in the game first.
            </p>
          )}
          {listed && hasDb && entries.length === 0 && (
            <p className="text-xs text-muted-foreground">No characters found.</p>
          )}
          {entries.length > 0 && (
            <div className="flex flex-col gap-1">
              {entries.map((e) => (
                <button
                  key={`${e.username}:${e.id}`}
                  onClick={() => void onSelect(e.id)}
                  className={
                    "flex w-full items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-left text-xs hover:bg-accent " +
                    (selectedId === e.id ? "border-primary bg-accent" : "border-border")
                  }
                >
                  <span className="font-medium">{e.name}</span>
                  <span className="font-mono text-muted-foreground">
                    {e.username} · #{e.id}
                  </span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Character record</CardTitle>
            {view && <Badge tone="ok">read-only</Badge>}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="rounded-md border border-yellow-900 bg-yellow-950/40 p-3 text-xs text-yellow-200">
            <span className="font-semibold">Read-only. </span>
            This record is gathered from the stored databases for inspection
            only — names, looks, deaths, saved state and items are never
            edited here. Change the running game through the admin channel,
            not this view.
          </div>
          {!view ? (
            <p className="text-xs text-muted-foreground">
              Pick an account&apos;s character on the left to see its record.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold">{view.name}</span>
                <Badge tone="info">{view.username}</Badge>
                <Badge tone="default">#{view.id}</Badge>
                <span className="text-xs text-muted-foreground">
                  created {fmtDate(view.createdAt)}
                </span>
              </div>

              <div>
                <SectionTitle>Look</SectionTitle>
                <div className="mt-1 flex flex-col gap-2">
                  {view.look.ok ? (
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone="default">{view.look.gender}</Badge>
                      {view.look.parts.map((p) => (
                        <Badge key={p.slot} tone="default">
                          {p.slot}: {p.name}
                        </Badge>
                      ))}
                      {view.look.parts.length === 0 && (
                        <span className="text-xs text-muted-foreground">starter look (no chosen parts)</span>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-red-400">
                      Stored look is not parseable — raw JSON below.
                    </p>
                  )}
                  {view.look.colours.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {view.look.colours.map((c) => (
                        <span
                          key={c.slot}
                          className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground"
                        >
                          <span
                            className="inline-block h-3 w-3 rounded-full border border-input"
                            style={{ backgroundColor: c.value }}
                          />
                          {c.slot}: <span className="font-mono">{c.value}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  <pre className="overflow-x-auto rounded-md border border-border bg-background p-2 font-mono text-[11px] text-muted-foreground">
                    {view.lookJson}
                  </pre>
                </div>
              </div>

              <div>
                <SectionTitle>Saved state</SectionTitle>
                <div className="mt-1">
                  {view.state ? (
                    <KvTable
                      rows={[
                        { key: "x", value: fmtNum(view.state.x) },
                        { key: "y", value: fmtNum(view.state.y) },
                        { key: "z", value: fmtNum(view.state.z) },
                        { key: "health", value: fmtNum(view.state.health) },
                        { key: "stamina", value: fmtNum(view.state.stamina) },
                      ]}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Never saved — the character spawns fresh.
                    </p>
                  )}
                </div>
              </div>

              <div>
                <SectionTitle>Deaths ({view.deaths.length})</SectionTitle>
                <div className="mt-1">
                  {view.deaths.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No deaths recorded.</p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-muted-foreground">
                          <th className="py-1 pr-3 font-medium">When</th>
                          <th className="py-1 pr-3 font-medium">x</th>
                          <th className="py-1 pr-3 font-medium">z</th>
                          <th className="py-1 font-medium">Killer</th>
                        </tr>
                      </thead>
                      <tbody>
                        {view.deaths.map((d, i) => (
                          <tr key={i} className="border-t border-border/50 font-mono">
                            <td className="py-1 pr-3">{fmtDate(d.at)}</td>
                            <td className="py-1 pr-3">{fmtNum(d.x)}</td>
                            <td className="py-1 pr-3">{fmtNum(d.z)}</td>
                            <td className="py-1">{d.killer === null ? "—" : `#${d.killer}`}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              <div>
                <SectionTitle>Items ({view.items.length})</SectionTitle>
                <div className="mt-1 flex flex-col gap-2">
                  {!hasWorldDb && (
                    <p className="text-xs text-muted-foreground">
                      No world.db in this world — no ledger items to show.
                    </p>
                  )}
                  {hasWorldDb && !defsResolved && view.items.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      No baked loot pool (loot/pool.jsonl) — showing definition
                      indices instead of names.
                    </p>
                  )}
                  {hasWorldDb && view.items.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No ledger items for this character (bag, hands and owned
                      ground drops).
                    </p>
                  )}
                  {view.items.length > 0 && (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-muted-foreground">
                          <th className="py-1 pr-3 font-medium">Item</th>
                          <th className="py-1 pr-3 font-medium">Where</th>
                          <th className="py-1 pr-3 font-medium">Name</th>
                          <th className="py-1 pr-3 font-medium">Rank</th>
                          <th className="py-1 pr-3 font-medium">Durability</th>
                          <th className="py-1 font-medium">Ground at</th>
                        </tr>
                      </thead>
                      <tbody>
                        {view.items.map((item) => (
                          <tr key={item.id} className="border-t border-border/50 font-mono">
                            <td className="py-1 pr-3">#{item.id}</td>
                            <td className="py-1 pr-3">
                              {item.where}
                              {item.where !== "ground" && item.where !== "created" ? ` · ${item.slot}` : ""}
                            </td>
                            <td className="py-1 pr-3">{item.name}</td>
                            <td className="py-1 pr-3">{item.rank || "—"}</td>
                            <td className="py-1 pr-3">{item.durability}</td>
                            <td className="py-1">
                              {item.where === "ground" ? `${fmtNum(item.x)}, ${fmtNum(item.z)}` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
