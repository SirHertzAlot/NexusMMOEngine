import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface RunnerSpec {
  repoRoot: string;
  modules: Array<{ modulePath: string; relSource: string }>;
  addComponentPath?: string;
}

interface FieldInfo {
  name: string;
  type: string;
  sab: boolean;
  arrayLength?: number;
}

interface ComponentInfo {
  name: string;
  componentId?: number;
  sab: boolean;
  tag: boolean;
  addable: boolean;
  source: string;
  fields: FieldInfo[];
}

const TYPED_ARRAY_TO_BITECS: Record<string, string> = {
  Int8Array: "i8",
  Uint8Array: "ui8",
  Uint8ClampedArray: "ui8c",
  Int16Array: "i16",
  Uint16Array: "ui16",
  Int32Array: "i32",
  Uint32Array: "ui32",
  Float32Array: "f32",
  Float64Array: "f64",
};

function hasSymbol(obj: object, description: string): boolean {
  return Object.getOwnPropertySymbols(obj).some((s) => s.description === description);
}

function isBitecsComponent(val: unknown): val is Record<string, unknown> {
  if (val === null || typeof val !== "object" || Array.isArray(val)) return false;
  return (
    hasSymbol(val, "tagStore") ||
    hasSymbol(val, "storeBase") ||
    hasSymbol(val, "storeFlattened")
  );
}

function inspectField(name: string, raw: unknown): FieldInfo | null {
  if (raw === null || typeof raw !== "object") return null;
  if (Array.isArray(raw)) {
    const first = raw[0] as unknown;
    if (first && typeof first === "object") {
      const ctorName = first.constructor?.name ?? "";
      const mapped = TYPED_ARRAY_TO_BITECS[ctorName];
      if (mapped) {
        const sab =
          typeof SharedArrayBuffer !== "undefined" &&
          (first as ArrayBufferView).buffer instanceof SharedArrayBuffer;
        const arrayLength = (first as ArrayBufferView & { length?: number }).length;
        return {
          name,
          type: mapped,
          sab,
          ...(typeof arrayLength === "number" && arrayLength > 0 ? { arrayLength } : {}),
        };
      }
    }
    return null;
  }

  const ctorName = raw.constructor?.name ?? "";
  const mapped = TYPED_ARRAY_TO_BITECS[ctorName];
  if (!mapped) return null;
  const sab =
    typeof SharedArrayBuffer !== "undefined" &&
    (raw as ArrayBufferView).buffer instanceof SharedArrayBuffer;
  return { name, type: mapped, sab };
}

async function main(): Promise<void> {
  const rawInput = readFileSync(0, "utf8");
  const spec = JSON.parse(rawInput) as RunnerSpec;
  const componentIds: Record<string, number> = {};
  const addableSet = new Set<string>();

  if (spec.addComponentPath) {
    try {
      const addMod = (await import(
        pathToFileURL(resolve(spec.repoRoot, spec.addComponentPath)).href
      )) as { COMPONENT_DEFAULTS?: Record<string, unknown> };
      for (const k of Object.keys(addMod.COMPONENT_DEFAULTS ?? {})) {
        addableSet.add(k);
      }
    } catch {
      // Optional add-component registry in synthetic fixtures
    }
  }

  const components: ComponentInfo[] = [];
  const seen = new Set<string>();

  for (const modEntry of spec.modules) {
    const abs = resolve(spec.repoRoot, modEntry.modulePath);
    const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;

    if (mod.COMPONENT_IDS && typeof mod.COMPONENT_IDS === "object") {
      for (const [k, v] of Object.entries(mod.COMPONENT_IDS as Record<string, unknown>)) {
        if (typeof v === "number") componentIds[k] = v;
      }
    }

    for (const exportName of Object.keys(mod).sort()) {
      const val = mod[exportName];
      if (!isBitecsComponent(val)) continue;
      if (seen.has(exportName)) continue;
      seen.add(exportName);

      const isTag = hasSymbol(val, "tagStore") && Object.keys(val).length === 0;
      const fields: FieldInfo[] = [];
      let allFieldsSab = !isTag;

      for (const key of Object.keys(val).sort()) {
        const info = inspectField(key, val[key]);
        if (!info) continue;
        fields.push(info);
        if (!info.sab) allFieldsSab = false;
      }
      if (fields.length === 0) allFieldsSab = false;

      components.push({
        name: exportName,
        ...(typeof componentIds[exportName] === "number"
          ? { componentId: componentIds[exportName] }
          : {}),
        sab: allFieldsSab,
        tag: isTag,
        addable: addableSet.has(exportName),
        source: modEntry.relSource,
        fields,
      });
    }
  }

  // Fill componentIds onto any component seen before COMPONENT_IDS was parsed (unlikely) and sort.
  for (const c of components) {
    if (c.componentId === undefined && typeof componentIds[c.name] === "number") {
      c.componentId = componentIds[c.name];
    }
  }
  components.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  process.stdout.write(
    JSON.stringify({
      components,
      addableNames: [...addableSet].sort(),
      componentIds,
    }),
  );
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
