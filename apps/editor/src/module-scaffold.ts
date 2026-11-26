/**
 * A new module, written for you (roadmap EB8).
 *
 * All 35 modules were hand-written, and a new one is four things in
 * agreement: a `module.json` the registry accepts, a server entry whose
 * `createSystems` returns one system per name the manifest declares, an
 * optional editor entry exporting panels, and the module's name in
 * `content/modules.json` so it is actually on. Getting one of the four
 * slightly wrong fails the boot — the set resolves against the manifest —
 * which is a poor first five minutes with the module system.
 *
 * This file is the generator and its refusals, pure and browser-safe so the
 * form and the host route apply the same rules. It produces file contents,
 * writes nothing, and knows nothing about the filesystem.
 */

/** The same rule `@mmo-engine/modules` holds manifests to. */
export const MODULE_NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface ScaffoldRequest {
  name: string;
  description: string;
  /** Module names this one needs; "core" is added when the list is empty. */
  dependsOn?: string[];
  /** System ids the server entry will provide. Empty means an editor-only module. */
  systems?: string[];
  /** Also write an editor entry with one empty panel. */
  editor?: boolean;
  /** The system this module's first system runs after, if it has an opinion. */
  after?: string;
}

export interface ScaffoldFile {
  /** Repository-relative path. */
  path: string;
  contents: string;
}

export interface ScaffoldPlan {
  name: string;
  files: ScaffoldFile[];
  /** What else has to happen for the module to run, said plainly. */
  next: string[];
}

export interface ScaffoldRefusal {
  path: string;
  message: string;
}

/**
 * Everything wrong with `req`, given the modules that already exist. An
 * empty list means `scaffoldModule` will produce a module the registry
 * accepts.
 */
export function refuseScaffold(req: ScaffoldRequest, existing: readonly string[]): ScaffoldRefusal[] {
  const out: ScaffoldRefusal[] = [];
  const bad = (path: string, message: string): void => void out.push({ path, message });
  if (typeof req.name !== "string" || !MODULE_NAME_RE.test(req.name)) {
    bad("name", "must be lowercase letters, digits and dashes, starting with a letter");
  } else if (existing.includes(req.name)) {
    bad("name", `a module called "${req.name}" already exists`);
  }
  if (typeof req.description !== "string" || req.description.trim().length === 0) {
    bad("description", "say what the module is for: it is what the Modules panel shows");
  }
  for (const d of req.dependsOn ?? []) {
    if (!MODULE_NAME_RE.test(d)) bad("dependsOn", `"${d}" is not a module name`);
    else if (!existing.includes(d)) bad("dependsOn", `"${d}" is not installed`);
  }
  (req.systems ?? []).forEach((s, i) => {
    if (!MODULE_NAME_RE.test(s)) bad(`systems[${i}]`, `"${s}" must be lowercase letters, digits and dashes`);
  });
  if (new Set(req.systems ?? []).size !== (req.systems ?? []).length) bad("systems", "two systems share a name");
  if ((req.systems ?? []).length === 0 && req.editor !== true) {
    bad("systems", "a module with no systems and no editor entry would do nothing");
  }
  return out;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function manifest(req: ScaffoldRequest): string {
  const systems = (req.systems ?? []).map((name, i) =>
    i === 0 && req.after ? { name, after: req.after } : { name },
  );
  return json({
    name: req.name,
    version: "0.1.0",
    description: req.description.trim(),
    dependsOn: req.dependsOn && req.dependsOn.length > 0 ? req.dependsOn : ["core"],
    ...(systems.length > 0 ? { server: { entry: "server/index.js", systems } } : {}),
    ...(req.editor ? { editor: { entry: "editor/index.tsx" } } : {}),
  });
}

function serverEntry(req: ScaffoldRequest): string {
  const systems = req.systems ?? [];
  const body = systems
    .map(
      (s) => `    "${s}": {
      name: "${s}",
      step() {
        // One tick of ${s}. Keep it allocation-free: this runs 30 times a second.
      },
    },`,
    )
    .join("\n");
  return `// Server entry of the ${req.name} module. \`createSystems\` receives the
// module context and returns one system per name the manifest declares —
// the names and this object's keys have to agree, or the boot stops and
// says which one is missing.
//
// Settings come from a game's \`game.json\` under \`modules["${req.name}"]\`,
// and the default beside each read is what applies when nothing sets it.
export function createSystems(ctx) {
  const settings = ctx.config?.["${req.name}"] ?? {};
  void settings;
  return {
${body}
  };
}
`;
}

function editorEntry(req: ScaffoldRequest): string {
  const title = req.name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  return `// Editor entry of the ${req.name} module: the panels it contributes to the
// shell's workspaces. A panel's \`render\` returns what the shell mounts, so
// this file owns the module's whole editor surface.
import * as React from "react";

export const panels = [
  {
    id: "${req.name}",
    // A workspace id of the shell: scene, world, scenes, dungeons, flow,
    // characters, release, liveops, changes, debug.
    workspace: "scene",
    title: "${title}",
    // A Material Symbols name.
    icon: "extension",
    render: () => <div className="p-4 text-sm">${title}: nothing here yet.</div>,
  },
];
`;
}

/** The files a new module is made of, and what is left for the person to do. */
export function scaffoldModule(req: ScaffoldRequest): ScaffoldPlan {
  const dir = `modules/${req.name}`;
  const files: ScaffoldFile[] = [{ path: `${dir}/module.json`, contents: manifest(req) }];
  if ((req.systems ?? []).length > 0) files.push({ path: `${dir}/server/index.js`, contents: serverEntry(req) });
  if (req.editor) files.push({ path: `${dir}/editor/index.tsx`, contents: editorEntry(req) });
  const next = [
    `Enable "${req.name}" in the Modules panel, then press Apply modules.`,
    ...((req.systems ?? []).length > 0
      ? [`Fill in step() for ${(req.systems ?? []).join(", ")}; the boot line will list ${(req.systems ?? []).length === 1 ? "it" : "them"} in the tick order.`]
      : []),
    ...(req.editor ? ["The editor panel appears in its workspace on the next refresh — no restart."] : []),
  ];
  return { name: req.name, files, next };
}
