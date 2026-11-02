/**
 * The Gameplay grids' read-only wildlife view (WL2): every species of the
 * wildlife table with the numbers the game reads, and the table's own checks.
 * Saving stays in the content files, so this view has no edit controls.
 */

import * as React from "react";
import { loadWildlife, type WildlifeSpecies, type WildlifeView } from "../gameplay-client.js";
import { Badge, Card, CardContent } from "./components.js";

const num = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function WildlifeViewPanel(): React.JSX.Element {
  const [view, setView] = React.useState<WildlifeView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState("");

  React.useEffect(() => {
    let live = true;
    loadWildlife().then(
      (v) => live && setView(v),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (!view) return <p className="text-sm text-muted-foreground">Loading the wildlife table…</p>;

  const q = filter.trim().toLowerCase();
  const rows: WildlifeSpecies[] = q === "" ? view.species : view.species.filter((s) => s.id.includes(q) || s.role.includes(q) || s.temperament.includes(q));
  const raiders = view.species.filter((s) => s.raidRangeM !== null).length;
  const bosses = view.species.filter((s) => s.boss).length;

  return (
    <div className="flex flex-col gap-3" aria-label="Wildlife table, read only">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{view.species.length} species</Badge>
        <Badge>{raiders} raiders</Badge>
        <Badge>{bosses} bosses</Badge>
        <Badge>{view.biomes.length} biomes</Badge>
        <span className="ml-auto text-xs text-muted-foreground">Read only: edit the species in content/wildlife/wildlife.json</span>
      </div>

      <Card>
        <CardContent>
          <p className="mb-2 text-sm font-medium">Checks</p>
          {view.problems.length === 0 ? (
            <p className="text-sm text-muted-foreground">The table passes its own checks: ratios per biome, rings, bosses.</p>
          ) : (
            <ul className="list-disc pl-5 text-sm text-destructive">
              {view.problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
        </CardContent>
      </Card>

      <input className="h-8 w-56 rounded border px-2 text-sm" placeholder="Filter by name, role or temperament" aria-label="Filter species" value={filter} onChange={(e) => setFilter(e.target.value)} />

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="p-2">Species</th>
              <th className="p-2">Role</th>
              <th className="p-2">Habitat</th>
              <th className="p-2">Temperament</th>
              <th className="p-2">Activity</th>
              <th className="p-2 text-right">Tier</th>
              <th className="p-2 text-right">Health</th>
              <th className="p-2 text-right">Notice m</th>
              <th className="p-2 text-right">Territory m</th>
              <th className="p-2 text-right">Wander m</th>
              <th className="p-2">Group</th>
              <th className="p-2 text-right">Size</th>
              <th className="p-2 text-right">Raid m</th>
              <th className="p-2">Biomes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-t">
                <td className="p-2 font-mono">{s.id}{s.boss && <Badge className="ml-2">boss</Badge>}</td>
                <td className="p-2">{s.role}</td>
                <td className="p-2">{s.habitat}</td>
                <td className="p-2">{s.temperament}</td>
                <td className="p-2">{s.activity}</td>
                <td className="p-2 text-right">{s.tier}</td>
                <td className="p-2 text-right">{num(s.health)}</td>
                <td className="p-2 text-right">{num(s.noticeM)}</td>
                <td className="p-2 text-right">{num(s.territoryM)}</td>
                <td className="p-2 text-right">{s.wanderM > 0 ? num(s.wanderM) : "—"}</td>
                <td className="p-2">{s.group}</td>
                <td className="p-2 text-right">{s.groupMin === s.groupMax ? s.groupMin : `${s.groupMin}–${s.groupMax}`}</td>
                <td className="p-2 text-right">{s.raidRangeM === null ? "—" : num(s.raidRangeM)}</td>
                <td className="p-2 text-xs text-muted-foreground">{s.biomes.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
