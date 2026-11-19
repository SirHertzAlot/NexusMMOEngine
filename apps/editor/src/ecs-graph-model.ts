/**
 * Browser-safe Graphify H4 view-model: joins static `ecs-graph.json` metadata
 * (components, fields, declaring systems, widgets, archetypes) with the
 * selection-scoped runtime overlay (`inspect { entity, format: "json" }`) and
 * compares `meta.builtFromCommit` against server/HEAD commits so stale graphs
 * never go unnoticed.
 */

export type EdgeConfidence = "declared" | "introspected" | "extracted" | "inferred";

export interface EcsGraphNode {
  id: string;
  kind: "component" | "field" | "system" | "module" | "object" | "archetype" | "verb" | "widget";
  name: string;
  role?: "simulation" | "infrastructure" | "authoring";
  module?: string;
  tickIndex?: number;
  declared?: boolean;
  archetype?: string;
  component?: string;
  fields?: Array<{ name: string; type: string; arrayLength?: number }>;
  tag?: boolean;
  modules?: string[];
}

export interface EcsGraphEdge {
  from: string;
  to: string;
  kind:
    | "hasComponent"
    | "fieldOf"
    | "reads"
    | "writes"
    | "excludes"
    | "instantiates"
    | "realizes"
    | "contributedBy"
    | "touches"
    | "summons"
    | "operatesOn";
  confidence: EdgeConfidence;
  source: string;
}

export interface EcsGraphMeta {
  schemaVersion: number;
  builtFromCommit: string;
  graphHash: string;
  counts?: {
    components?: number;
    systems?: number;
    declaredSystems?: number;
    simulationSystems?: number;
    nodes?: number;
    edges?: number;
    unresolved?: number;
  };
}

export interface EcsGraphPayload {
  meta: EcsGraphMeta;
  nodes: EcsGraphNode[];
  edges: EcsGraphEdge[];
  currentHead?: string | null;
}

export interface LiveWriterRecord {
  system: string;
  tick: number;
}

export interface LiveOverlayField {
  name: string;
  value: unknown;
  lastWriter?: LiveWriterRecord;
}

export interface LiveOverlayComponent {
  component: string;
  tag?: boolean;
  fields: LiveOverlayField[];
}

export interface LiveEntityOverlay {
  wireId: string;
  slot: number;
  tick: number;
  buildCommit: string | null;
  components: LiveOverlayComponent[];
}

export interface GraphStaleness {
  state: "synced" | "stale" | "unknown";
  graphCommit: string;
  compareCommit: string | null;
  compareLabel: "server" | "repo HEAD" | "none";
  reason: string;
}

export interface SystemAccessBadge {
  system: string;
  role: string;
  declared: boolean;
  confidence: EdgeConfidence;
  tickIndex?: number;
  fields: string[];
}

export interface FootprintFieldRow {
  name: string;
  type?: string;
  liveValue?: string;
  lastWriter?: LiveWriterRecord;
  readers: Array<{ system: string; confidence: EdgeConfidence }>;
  writers: Array<{ system: string; confidence: EdgeConfidence }>;
}

export interface FootprintComponentSection {
  component: string;
  tag: boolean;
  widgets: string[];
  readers: SystemAccessBadge[];
  writers: SystemAccessBadge[];
  excludes: SystemAccessBadge[];
  fields: FootprintFieldRow[];
}

export interface EntityFootprint {
  archetypeId: string | null;
  components: FootprintComponentSection[];
}

const MIRROR_COMPONENT_ALIASES: Readonly<Record<string, string>> = {
  transform: "Transform",
  velocity: "Velocity",
  intent: "PlayerIntent",
  playerintent: "PlayerIntent",
  chunk: "Chunk",
  health: "Health",
  stamina: "Stamina",
  needs: "Needs",
  body: "BodyConfig",
  bodyconfig: "BodyConfig",
  pathrequest: "PathRequest",
  pathstate: "PathState",
  navagent: "NavAgent",
  asset: "AssetRef",
  assetref: "AssetRef",
  locomotion: "Locomotion",
  appearance: "Appearance",
  action: "Action",
  characterref: "CharacterRef",
  worlditem: "WorldItem",
  animation: "Animation",
  flowref: "FlowRef",
  vfxemitter: "VfxEmitter",
  audioemitter: "AudioEmitter",
  god: "God",
  breakable: "Breakable",
  noclip: "Noclip",
  farvisible: "FarVisible",
  mana: "Mana",
  injury: "Injury",
};

/** Normalize editor/mirror/scene component labels onto canonical bitECS component names. */
export function normalizeComponentName(raw: string, knownComponents?: ReadonlySet<string>): string {
  const trimmed = raw.trim();
  if (knownComponents?.has(trimmed)) return trimmed;
  const alias = MIRROR_COMPONENT_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  if (knownComponents) {
    const lower = trimmed.toLowerCase();
    for (const c of knownComponents) {
      if (c.toLowerCase() === lower) return c;
    }
  }
  return trimmed;
}

const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 8) : "unknown");

function commitsMatch(a: string, b: string): boolean {
  const la = a.trim().toLowerCase();
  const lb = b.trim().toLowerCase();
  if (!la || !lb || la === "unknown" || lb === "unknown") return false;
  return la === lb || la.startsWith(lb) || lb.startsWith(la);
}

/**
 * Compare `graph.meta.builtFromCommit` against the running server's `buildCommit`
 * (or repo `HEAD` when offline) so stale graph artifacts are always badged explicitly.
 */
export function checkGraphStaleness(
  builtFromCommit: string | null | undefined,
  serverBuildCommit?: string | null,
  currentHead?: string | null,
): GraphStaleness {
  const graphCommit = (builtFromCommit ?? "").trim() || "unknown";
  const compareCommit = (serverBuildCommit ?? currentHead ?? "").trim() || null;
  const compareLabel: GraphStaleness["compareLabel"] = serverBuildCommit ? "server" : currentHead ? "repo HEAD" : "none";
  if (!compareCommit || graphCommit === "unknown") {
    return {
      state: "unknown",
      graphCommit,
      compareCommit,
      compareLabel,
      reason: `built ${shortSha(graphCommit)} (no ${compareLabel === "none" ? "live/HEAD" : compareLabel} commit to compare)`,
    };
  }
  if (commitsMatch(graphCommit, compareCommit)) {
    return {
      state: "synced",
      graphCommit,
      compareCommit,
      compareLabel,
      reason: `synced · ${shortSha(graphCommit)}`,
    };
  }
  return {
    state: "stale",
    graphCommit,
    compareCommit,
    compareLabel,
    reason: `stale · graph ${shortSha(graphCommit)} != ${compareLabel} ${shortSha(compareCommit)}`,
  };
}

export interface EcsGraphIndex {
  meta: EcsGraphMeta;
  currentHead: string | null;
  components: ReadonlySet<string>;
  componentMeta: ReadonlyMap<string, EcsGraphNode>;
  fieldsByComponent: ReadonlyMap<string, Array<{ name: string; type: string }>>;
  widgetsByComponent: ReadonlyMap<string, string[]>;
  /** Key: `"reads"`, `"writes"`, or `"excludes"` -> `Component` -> list of system badges. */
  accessByComponent: ReadonlyMap<string, { reads: SystemAccessBadge[]; writes: SystemAccessBadge[]; excludes: SystemAccessBadge[] }>;
  /** Key: `"Component.field"` -> readers/writers. */
  accessByField: ReadonlyMap<string, { readers: Array<{ system: string; confidence: EdgeConfidence }>; writers: Array<{ system: string; confidence: EdgeConfidence }> }>;
  archetypeByObjectId: ReadonlyMap<string, string>;
  componentsByArchetype: ReadonlyMap<string, string[]>;
}

const CONFIDENCE_RANK: Readonly<Record<EdgeConfidence, number>> = {
  declared: 4,
  introspected: 3,
  extracted: 2,
  inferred: 1,
};

type SystemAccessBucket = Map<string, { sysNode?: EcsGraphNode; confidence: EdgeConfidence; fields: Set<string> }>;
type SystemAccessBucketMap = Map<string, SystemAccessBucket>;

/** Pre-index an `EcsGraphPayload` into O(1) lookup tables for entity footprint views. */
export function indexEcsGraph(payload: EcsGraphPayload): EcsGraphIndex {
  const nodesById = new Map<string, EcsGraphNode>();
  const components = new Set<string>();
  const componentMeta = new Map<string, EcsGraphNode>();
  const fieldsByComponent = new Map<string, Array<{ name: string; type: string }>>();
  const widgetsByComponent = new Map<string, string[]>();
  const archetypeByObjectId = new Map<string, string>();
  const componentsByArchetype = new Map<string, string[]>();

  for (const n of payload.nodes) {
    nodesById.set(n.id, n);
    if (n.kind === "component") {
      components.add(n.name);
      componentMeta.set(n.name, n);
      fieldsByComponent.set(
        n.name,
        (n.fields ?? []).map((f) => ({ name: f.name, type: f.type })),
      );
    } else if (n.kind === "object" && n.archetype) {
      archetypeByObjectId.set(n.id.replace(/^object:/, ""), n.archetype);
    }
  }

  const byCompKind: Record<"reads" | "writes" | "excludes", SystemAccessBucketMap> = {
    reads: new Map(),
    writes: new Map(),
    excludes: new Map(),
  };
  const accessByField = new Map<string, { readers: Array<{ system: string; confidence: EdgeConfidence }>; writers: Array<{ system: string; confidence: EdgeConfidence }> }>();

  const touchCompBucket = (
    kind: "reads" | "writes" | "excludes",
    comp: string,
    sysId: string,
    confidence: EdgeConfidence,
    field?: string,
  ): void => {
    let sysMap = byCompKind[kind].get(comp);
    if (!sysMap) byCompKind[kind].set(comp, (sysMap = new Map()));
    const existing = sysMap.get(sysId);
    if (!existing) {
      sysMap.set(sysId, { sysNode: nodesById.get(sysId), confidence, fields: new Set(field ? [field] : []) });
    } else {
      if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[existing.confidence]) existing.confidence = confidence;
      if (field) existing.fields.add(field);
    }
  };

  for (const e of payload.edges) {
    if (e.kind === "summons" && e.from.startsWith("component:") && e.to.startsWith("widget:")) {
      const comp = e.from.slice("component:".length);
      const w = e.to.slice("widget:".length);
      const list = widgetsByComponent.get(comp) ?? [];
      if (!list.includes(w)) list.push(w);
      widgetsByComponent.set(comp, list);
    } else if (e.kind === "operatesOn" && e.from.startsWith("widget:") && e.to.startsWith("component:")) {
      const comp = e.to.slice("component:".length);
      const w = e.from.slice("widget:".length);
      const list = widgetsByComponent.get(comp) ?? [];
      if (!list.includes(w)) list.push(w);
      widgetsByComponent.set(comp, list);
    } else if (e.kind === "instantiates" && e.from.startsWith("object:") && e.to.startsWith("archetype:")) {
      archetypeByObjectId.set(e.from.slice("object:".length), e.to);
    } else if (e.kind === "hasComponent" && e.from.startsWith("archetype:") && e.to.startsWith("component:")) {
      const list = componentsByArchetype.get(e.from) ?? [];
      list.push(e.to.slice("component:".length));
      componentsByArchetype.set(e.from, list);
    } else if ((e.kind === "reads" || e.kind === "writes" || e.kind === "excludes") && e.from.startsWith("system:")) {
      const sysId = e.from;
      const sysNode = nodesById.get(sysId);
      const sysName = sysNode?.name ?? sysId.slice("system:".length);
      if (e.to.startsWith("component:")) {
        touchCompBucket(e.kind, e.to.slice("component:".length), sysId, e.confidence);
      } else if (e.to.startsWith("field:") && (e.kind === "reads" || e.kind === "writes")) {
        const key = e.to.slice("field:".length);
        const dot = key.indexOf(".");
        if (dot > 0) {
          const comp = key.slice(0, dot);
          const field = key.slice(dot + 1);
          touchCompBucket(e.kind, comp, sysId, e.confidence, field);
          let fEntry = accessByField.get(key);
          if (!fEntry) accessByField.set(key, (fEntry = { readers: [], writers: [] }));
          const list = e.kind === "reads" ? fEntry.readers : fEntry.writers;
          if (!list.some((x) => x.system === sysName)) list.push({ system: sysName, confidence: e.confidence });
        }
      }
    }
  }

  const accessByComponent = new Map<string, { reads: SystemAccessBadge[]; writes: SystemAccessBadge[]; excludes: SystemAccessBadge[] }>();
  const toBadges = (m: SystemAccessBucket | undefined): SystemAccessBadge[] => {
    if (!m) return [];
    const list: SystemAccessBadge[] = [];
    for (const [sysId, info] of m) {
      list.push({
        system: info.sysNode?.name ?? sysId.slice("system:".length),
        role: info.sysNode?.role ?? "simulation",
        declared: Boolean(info.sysNode?.declared),
        confidence: info.confidence,
        tickIndex: info.sysNode?.tickIndex,
        fields: [...info.fields].sort(),
      });
    }
    return list.sort((a, b) => (a.tickIndex ?? 999) - (b.tickIndex ?? 999) || a.system.localeCompare(b.system));
  };

  for (const comp of components) {
    accessByComponent.set(comp, {
      reads: toBadges(byCompKind.reads.get(comp)),
      writes: toBadges(byCompKind.writes.get(comp)),
      excludes: toBadges(byCompKind.excludes.get(comp)),
    });
  }

  return {
    meta: payload.meta,
    currentHead: payload.currentHead ?? null,
    components,
    componentMeta,
    fieldsByComponent,
    widgetsByComponent,
    accessByComponent,
    accessByField,
    archetypeByObjectId,
    componentsByArchetype,
  };
}

function formatOverlayVal(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/**
 * Join static graph relationships + live overlay values + per-field runtime `lastWriter`
 * for one entity or scene object selection.
 */
export function buildEntityFootprint(
  index: EcsGraphIndex,
  input: {
    componentNames: readonly string[];
    objectId?: string;
    live?: LiveEntityOverlay | null;
  },
): EntityFootprint {
  const archetypeId = input.objectId ? (index.archetypeByObjectId.get(input.objectId) ?? null) : null;
  const archetypeComps = archetypeId ? (index.componentsByArchetype.get(archetypeId) ?? []) : [];

  const liveByComp = new Map<string, LiveOverlayComponent>();
  if (input.live) {
    for (const c of input.live.components) liveByComp.set(c.component, c);
  }

  const orderedNames: string[] = [];
  const seen = new Set<string>();
  const addName = (raw: string): void => {
    const norm = normalizeComponentName(raw, index.components);
    if (!seen.has(norm)) {
      seen.add(norm);
      orderedNames.push(norm);
    }
  };
  if (input.live) for (const c of input.live.components) addName(c.component);
  for (const c of input.componentNames) addName(c);
  for (const c of archetypeComps) addName(c);

  const sections: FootprintComponentSection[] = [];
  for (const comp of orderedNames) {
    const meta = index.componentMeta.get(comp);
    const liveComp = liveByComp.get(comp);
    const access = index.accessByComponent.get(comp);
    const schemaFields = index.fieldsByComponent.get(comp) ?? [];
    const liveFields = new Map<string, LiveOverlayField>();
    if (liveComp) for (const f of liveComp.fields) liveFields.set(f.name, f);

    const fieldNames: string[] = [];
    const fieldSeen = new Set<string>();
    for (const f of schemaFields) {
      fieldSeen.add(f.name);
      fieldNames.push(f.name);
    }
    if (liveComp) {
      for (const f of liveComp.fields) {
        if (!fieldSeen.has(f.name)) {
          fieldSeen.add(f.name);
          fieldNames.push(f.name);
        }
      }
    }

    const typeByField = new Map(schemaFields.map((f) => [f.name, f.type]));
    const rows: FootprintFieldRow[] = fieldNames.map((fn) => {
      const lf = liveFields.get(fn);
      const fAccess = index.accessByField.get(`${comp}.${fn}`);
      return {
        name: fn,
        type: typeByField.get(fn),
        ...(lf !== undefined ? { liveValue: formatOverlayVal(lf.value) } : {}),
        ...(lf?.lastWriter ? { lastWriter: lf.lastWriter } : {}),
        readers: fAccess?.readers ?? [],
        writers: fAccess?.writers ?? [],
      };
    });

    sections.push({
      component: comp,
      tag: Boolean(meta?.tag ?? liveComp?.tag),
      widgets: index.widgetsByComponent.get(comp) ?? [],
      readers: access?.reads ?? [],
      writers: access?.writes ?? [],
      excludes: access?.excludes ?? [],
      fields: rows,
    });
  }

  return { archetypeId, components: sections };
}

/** Parse a JSON payload returned by `admin("inspect", { entity, format: "json" })`. */
export function parseLiveEntityOverlay(raw: string): LiveEntityOverlay {
  const parsed = JSON.parse(raw) as Partial<LiveEntityOverlay>;
  if (!parsed || typeof parsed !== "object" || typeof parsed.wireId !== "string" || !Array.isArray(parsed.components)) {
    throw new Error("invalid H4 live inspect JSON payload");
  }
  return {
    wireId: parsed.wireId,
    slot: typeof parsed.slot === "number" ? parsed.slot : -1,
    tick: typeof parsed.tick === "number" ? parsed.tick : 0,
    buildCommit: typeof parsed.buildCommit === "string" ? parsed.buildCommit : null,
    components: parsed.components,
  };
}

/** Fetch the Graphify graph slice from the editor dev host. */
export async function fetchEcsGraph(objectId?: string): Promise<EcsGraphPayload> {
  const qs = objectId ? `?object=${encodeURIComponent(objectId)}` : "";
  const res = await fetch(`/api/editor/graph${qs}`);
  const body = (await res.json()) as { ok?: boolean; graph?: EcsGraphPayload; error?: string };
  if (!res.ok || !body.ok || !body.graph) {
    throw new Error(body.error ?? `graph fetch failed: HTTP ${res.status}`);
  }
  return body.graph;
}
