/**
 * Towns panel: the town generator's rules (content/settlements/rules.json), section by section, and a
 * preview that builds one town from the rules as they stand, saved or not.
 *
 * The sections are the rules file's top-level fields. Those a designer tunes by number have a labelled form
 * with help (town-rules.ts, roadmap EG4) and can still open the full tree; the rest are edited with the Rules
 * panel's tree editor. Save
 * checks the whole file on the host (the schema, then every archetype the rules name) and writes it back
 * pretty-printed only when it is clean; problems show per path, inline and in a list. The settlement
 * bakes read the saved file (`npm run settlement:bake`, `bake:all`).
 */

import * as React from "react";
import { DocBar } from "./doc-bar.js";
import { useSaveTask } from "./use-save-task.js";
import { NodeEditor } from "./rules-editor.js";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, SectionTitle, Select } from "./components.js";
import { sameValue } from "../document-state.js";
import { NO_HISTORY, useDocActions } from "./doc-actions.js";
import { groupIssues, setAtPath, type RuleIssueView } from "../rules-tree.js";
import { TOWN_FORMS } from "../town-rules.js";
import { FieldSection } from "./spec-form.js";
import {
  getSettlementRules,
  LAND_PRESET_LABELS,
  previewSettlement,
  saveSettlementRules,
  type LandPreset,
  type SettlementPreview,
} from "../settlement-preview.js";

/** What each section of the rules sets, in the order the panel lists them. */
export const SECTIONS: [key: string, label: string, blurb: string][] = [
  ["demographics", "People", "Household size, ages, classes and who works."],
  ["districtShares", "Districts", "How the blocks split between housing, farms, shops and crafts."],
  ["layout", "Layout", "Blocks, plot size, streets, shared homes, the craft quarter."],
  ["archetypes", "Buildings", "Every building kind: where it stands, who lives and works there, its storeys."],
  ["required", "Required buildings", "How many of each a town needs, by its people."],
  ["forbiddenAdjacent", "Never neighbours", "Buildings that may not stand side by side."],
  ["industry", "Industry, trade & guilds", "What towns live off, their goods and prices, guild ranks, resource nodes."],
  ["mastery", "Masters", "How many masters a town has, what they draw, and grand masters."],
  ["settings", "Access", "Ports, river, road and remote towns: their size caps, density and growth."],
  ["sites", "Sites", "Where a town may stand: slope, water, height, fertility."],
  ["farming", "Farming", "Acres per person and field shape."],
  ["watch", "Watch", "Guard posts, headquarters, gaol, and the poor and rich streets."],
  ["homeless", "Homeless", "How many have no home, and where they sleep."],
  ["openGround", "Parks & lots", "Parks per people and empty lots by trend."],
  ["props", "Street dressing", "Lamps, benches, fountains, statues, barrels, terraces."],
  ["worship", "Worship", "Churches' seats for a share of the people."],
  ["fortification", "Walls", "When a town is walled, and its wall, towers and gates."],
  ["architecture", "Architecture", "Storey, ceiling and roof heights against the human."],
  ["version", "Version", "The rules' version, written into every baked town."],
];

/** Plan colours by district kind (fill only; text stays in the theme's ink). */
const KIND_FILL: Record<string, string> = {
  housing: "#c9a26b",
  agriculture: "#7fa05a",
  shopping: "#d27b55",
  manufacturing: "#8a8f98",
  civic: "#5f86c0",
  entertainment: "#b06aa8",
  education: "#4fa3a0",
};
const NODE_FILL: Record<string, string> = { tree_stand: "#2f7d3a", ore_vein: "#b8b8c8", fishing_spot: "#3a8fd6" };

function TownPlan({ plan }: { plan: Extract<SettlementPreview, { ok: true }>["plan"] }): React.JSX.Element {
  // Framed on the town and its resource nodes: the farms run out along the roads for kilometres.
  const framed = plan.parcels.filter((p) => p.kind !== "agriculture");
  const pts = [...(framed.length ? framed : plan.parcels).map((p) => [p.x, p.z, p.side / 2] as const), ...plan.resources.map((r) => [r.x, r.z, 3] as const)];
  const minX = Math.min(...pts.map(([x, , h]) => x - h));
  const maxX = Math.max(...pts.map(([x, , h]) => x + h));
  const minZ = Math.min(...pts.map(([, z, h]) => z - h));
  const maxZ = Math.max(...pts.map(([, z, h]) => z + h));
  const pad = 10;
  const w = maxX - minX + pad * 2;
  const h = maxZ - minZ + pad * 2;
  const dot = Math.max(3, Math.max(w, h) / 120);
  return (
    <svg viewBox={`${minX - pad} ${minZ - pad} ${w} ${h}`} overflow="hidden" className="w-full rounded-md border border-border bg-background" style={{ aspectRatio: `${w} / ${h}`, maxHeight: 420 }} role="img" aria-label="Town plan">
      {plan.parcels.map((p, i) => (
        <rect key={i} x={p.x - p.side / 2} y={p.z - p.side / 2} width={p.side} height={p.side} fill={KIND_FILL[p.kind] ?? "#777"} opacity={0.85} stroke="var(--background, #111)" strokeWidth={Math.max(0.5, p.side / 40)}>
          <title>{p.kind}</title>
        </rect>
      ))}
      {plan.resources.map((r, i) => (
        <circle key={i} cx={r.x} cy={r.z} r={dot} fill={NODE_FILL[r.kind] ?? "#e0c050"} stroke="#111" strokeWidth={dot / 4}>
          <title>{r.kind.replace(/_/g, " ")}</title>
        </circle>
      ))}
    </svg>
  );
}

function PlanLegend({ kinds, nodes }: { kinds: string[]; nodes: string[] }): React.JSX.Element {
  const chip = (fill: string, label: string, round: boolean): React.JSX.Element => (
    <span key={label} className="flex items-center gap-1">
      <span className={round ? "inline-block h-2.5 w-2.5 rounded-full" : "inline-block h-2.5 w-2.5 rounded-sm"} style={{ background: fill }} />
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {kinds.map((k) => chip(KIND_FILL[k] ?? "#777", k, false))}
      {nodes.map((n) => chip(NODE_FILL[n] ?? "#e0c050", n.replace(/_/g, " "), true))}
    </div>
  );
}

function PreviewCard({ content }: { content: unknown }): React.JSX.Element {
  const [population, setPopulation] = React.useState(1000);
  const [seed, setSeed] = React.useState(1);
  const [land, setLand] = React.useState<LandPreset>("forest");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<SettlementPreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function build(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setResult(await previewSettlement("", content, population, seed, land));
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const ok = result?.ok === true ? result : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Preview a town</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">Builds one road town from the rules as they are now, saved or not. Nothing is written.</p>
        <div className="grid grid-cols-3 gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">People</span>
            <Input type="number" min={1} max={20000} value={population} onChange={(e) => setPopulation(e.target.valueAsNumber || 1)} aria-label="Preview population" className="h-8 text-xs" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Seed</span>
            <Input type="number" min={0} value={seed} onChange={(e) => setSeed(e.target.valueAsNumber || 0)} aria-label="Preview seed" className="h-8 text-xs" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Land</span>
            <Select size="xs" value={land} onChange={(e) => setLand(e.target.value as LandPreset)} aria-label="Preview land">
              {(Object.keys(LAND_PRESET_LABELS) as LandPreset[]).map((k) => (
                <option key={k} value={k}>{LAND_PRESET_LABELS[k]}</option>
              ))}
            </Select>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void build()} disabled={busy}>{busy ? "Building…" : "Build town"}</Button>
          <Button size="sm" variant="outline" onClick={() => { setSeed((s) => s + 1); }} disabled={busy}>Next seed</Button>
        </div>
        {error !== null && <p className="text-xs text-red-400">{error}</p>}
        {result && !result.ok && (
          <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-xs text-red-200">
            {result.error ?? `The rules have ${result.issues?.length ?? 0} problem${result.issues?.length === 1 ? "" : "s"}: fix them first.`}
          </div>
        )}
        {ok && (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge>{ok.population} people</Badge>
              <Badge>{ok.households} households</Badge>
              <Badge>{ok.structures} buildings</Badge>
              <Badge>{ok.walled ? "walled" : "open village"}</Badge>
              <Badge tone={ok.gates.failed.length ? "warn" : "info"}>{ok.gates.total - ok.gates.failed.length}/{ok.gates.total} checks pass</Badge>
            </div>
            <TownPlan plan={ok.plan} />
            <PlanLegend kinds={[...new Set(ok.plan.parcels.map((p) => p.kind))].sort()} nodes={[...new Set(ok.plan.resources.map((r) => r.kind))].sort()} />
            <p className="text-[11px] text-muted-foreground">The town and the resource nodes round it; its {ok.plan.parcels.filter((p) => p.kind === "agriculture").length} farm plots run on out along the roads.</p>
            <div className="grid grid-cols-1 gap-3 text-xs xl:grid-cols-2">
              <div>
                <SectionTitle>Industry</SectionTitle>
                {ok.industry ? (
                  <p className="mt-1">
                    <span className="font-medium capitalize">{ok.industry.primary}</span>
                    {ok.industry.workplace && <> at the {ok.industry.workplace.replace(/_/g, " ")}</>}
                    {ok.industry.product && <>; known for {ok.industry.product.export} (tier {ok.industry.product.tier} {ok.industry.product.material})</>}
                  </p>
                ) : (
                  <p className="mt-1 text-muted-foreground">None: pick a land so the town has one.</p>
                )}
                {ok.guild && (
                  <p className="mt-1">
                    <span className="font-medium capitalize">{ok.guild.profession}</span> guild{ok.guild.hasHall ? " with a hall" : " (too small for a hall)"}: {ok.guild.ranks.join(", ")}
                  </p>
                )}
              </div>
              <div>
                <SectionTitle>Resource nodes</SectionTitle>
                {ok.resources.length === 0 ? (
                  <p className="mt-1 text-muted-foreground">None round this town.</p>
                ) : (
                  <ul className="mt-1">
                    {ok.resources.map((r) => (
                      <li key={`${r.kind}-${r.material}`}>
                        {r.nodes} × {r.kind.replace(/_/g, " ")} of {r.material.replace(/-/g, " ")} (tier {r.tier}), {r.stock} gathers in all
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="xl:col-span-2">
                <SectionTitle>Buildings</SectionTitle>
                <p className="mt-1 text-muted-foreground">
                  {ok.archetypes.map(([a, n]) => `${a.replace(/_/g, " ")} ${n}`).join(" · ")}
                </p>
              </div>
            </div>
            {ok.gates.failed.length > 0 && <p className="text-xs text-amber-400">Failed checks: {ok.gates.failed.join(", ")}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function SettlementPanel(): React.JSX.Element {
  const [content, setContent] = React.useState<Record<string, unknown> | null>(null);
  const [pristine, setPristine] = React.useState<Record<string, unknown> | null>(null);
  const [missing, setMissing] = React.useState(false);
  const [section, setSection] = React.useState("industry");
  const [showTree, setShowTree] = React.useState(false);
  const task = useSaveTask<RuleIssueView>();
  const { issues, busy: saving } = task;
  const error = task.status?.tone === "bad" ? task.status.text : null;
  const savedNote = task.status?.tone === "ok" ? task.status.text : null;

  React.useEffect(() => {
    let live = true;
    getSettlementRules("")
      .then((r) => {
        if (!live) return;
        setContent(r.content as Record<string, unknown>);
        setPristine(r.content as Record<string, unknown>);
        setMissing(r.missing);
      })
      .catch((err: unknown) => {
        if (live) task.setStatus({ tone: "bad", text: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      live = false;
    };
  }, []);

  const dirty = content !== null && pristine !== null && !sameValue(content, pristine);

  async function onSave(): Promise<void> {
    if (content === null) return;
    if (!(await task.run(() => saveSettlementRules("", content), { ok: "Saved: checked and written to content/settlements/rules.json. The next settlement bake uses it.", refused: () => null }))) return;
    setPristine(content);
    setMissing(false);
  }

  useDocActions(() => {
    if (content === null) return null;
    return {
      label: "town rules",
      canSave: dirty,
      ...NO_HISTORY,
      save: () => void onSave(),
      canRevert: dirty,
      revert: () => setContent(structuredClone(pristine)),
      exportDoc: () => ({ name: "settlement-rules", data: content }),
      importDoc: (incoming: unknown) => setContent(incoming as Record<string, unknown>),
    };
  });

  const errors = groupIssues(issues);
  const issuesIn = (key: string): number => issues.filter((i) => i.path === key || i.path.startsWith(`${key}.`) || i.path.startsWith(`${key}[`)).length;
  const label = SECTIONS.find(([k]) => k === section)?.[1] ?? section;
  const known = new Set(SECTIONS.map(([k]) => k));
  const extra = content ? Object.keys(content).filter((k) => !known.has(k)) : [];
  const form = TOWN_FORMS[section];
  // The spec-form fields look issues up by `<file>.json` and dotted paths.
  const formIssues = issues.map((i) => ({ file: "rules.json", path: i.path, message: i.message }));
  const archetypes = Object.keys((content?.archetypes as Record<string, unknown> | undefined) ?? {});
  const onFormChange = (next: unknown): void => {
    setContent(next as Record<string, unknown>);
    task.setStatus(null);
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)] 2xl:grid-cols-[240px_minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Town rules</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {content === null ? (
            <p className="text-xs text-muted-foreground">{error ?? "Loading…"}</p>
          ) : (
            [...SECTIONS.filter(([k]) => k in content), ...extra.map((k) => [k, k, ""] as [string, string, string])].map(([k, l, blurb]) => (
              <button
                key={k}
                onClick={() => {
                  setSection(k);
                  setShowTree(false);
                }}
                className={"flex w-full flex-col items-start gap-0.5 rounded-md border px-3 py-1.5 text-left text-xs hover:bg-accent " + (section === k ? "border-primary bg-accent" : "border-border")}
              >
                <span className="flex w-full items-center justify-between gap-2 font-medium">
                  {l}
                  {issuesIn(k) > 0 && <Badge tone="warn">{issuesIn(k)}</Badge>}
                </span>
                <span className="text-muted-foreground">{blurb}</span>
              </button>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>{label}</CardTitle>
            <div className="flex items-center gap-2">
              {dirty && <Badge tone="warn">unsaved changes</Badge>}
              {missing && <Badge tone="info">new file (built-in rules shown)</Badge>}
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {content === null ? (
            <p className="text-xs text-muted-foreground">{error ?? "Loading…"}</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                content/settlements/rules.json: the rules every baked town is built from. Save checks the whole file and writes it only when it is clean.
              </p>
              {issues.length > 0 && (
                <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-xs text-red-200">
                  <span className="font-semibold">Not saved: {issues.length} problem{issues.length === 1 ? "" : "s"}</span>
                  <ul className="mt-1 list-disc pl-5 font-mono">
                    {issues.map((i, n) => (
                      <li key={n}>
                        <button type="button" className="underline-offset-2 hover:underline" onClick={() => setSection(i.path.split(/[.[]/)[0] || section)}>
                          {i.path === "" ? "(file)" : i.path}
                        </button>
                        : {i.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {error !== null && <p className="text-xs text-red-400">{error}</p>}
              {savedNote !== null && <p className="text-xs text-green-400">{savedNote}</p>}
              {form && section in content && (
                <div className="flex flex-col gap-5">
                  {form.map((f) => (
                    <FieldSection key={f.title} title={f.title} help={f.help} fields={f.fields} basePath={section} value={content} file="rules" issues={formIssues} lists={{ archetypes }} onChange={onFormChange} narrow />
                  ))}
                </div>
              )}
              <div>
                <div className="flex items-center justify-between">
                  <SectionTitle>{form ? "All values" : "Values"}</SectionTitle>
                  {form && (
                    <Button size="sm" variant="outline" onClick={() => setShowTree((v) => !v)}>
                      {showTree ? "Hide tree" : "Show tree"}
                    </Button>
                  )}
                </div>
                <div className="mt-2">
                  {form && !showTree ? null : section in content ? (
                    <NodeEditor
                      segments={[section]}
                      value={content[section]}
                      onChange={(nv) => {
                        setContent(setAtPath(content, [section], nv) as Record<string, unknown>);
                        task.setStatus(null);
                      }}
                      onRemove={null}
                      errors={errors}
                      depth={0}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">Not in this file.</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <DocBar
                  dirty={dirty}
                  busy={saving}
                  saveLabel={saving ? "Saving…" : "Save"}
                  onSave={() => void onSave()}
                  onRevert={() => {
                    setContent(pristine);
                    task.clear();
                  }}
                />
                <span className="text-xs text-muted-foreground">Bake with npm run settlement:bake or bake:all.</span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="lg:col-span-2 2xl:col-span-1">{content !== null && <PreviewCard content={content} />}</div>
    </div>
  );
}
