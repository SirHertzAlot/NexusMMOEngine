import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { kitSrcDirs, walkFiles } from "./ast-extract.js";
import { toPosixPath } from "./schema.js";

export interface IntrospectModuleSpec {
  /** Compiled ES module path (absolute or relative to repoRoot). */
  modulePath: string;
  /** POSIX repository source file path recorded on emitted nodes/edges. */
  relSource: string;
}

export interface IntrospectedField {
  name: string;
  type: string;
  sab: boolean;
  arrayLength?: number;
}

export interface IntrospectedComponent {
  name: string;
  componentId?: number;
  sab: boolean;
  tag: boolean;
  addable: boolean;
  source: string;
  fields: IntrospectedField[];
}

export interface IntrospectionResult {
  components: IntrospectedComponent[];
  addableNames: string[];
  componentIds: Record<string, number>;
}

export interface IntrospectOptions {
  repoRoot: string;
  modules?: readonly IntrospectModuleSpec[];
  addComponentPath?: string;
}

/** The engine's own components, which every run has. */
export const ENGINE_INTROSPECT_MODULES: readonly IntrospectModuleSpec[] = [
  {
    modulePath: "packages/engine-core/dist/src/components.js",
    relSource: "packages/engine-core/src/components.ts",
  },
];

/**
 * The component modules of the kits installed beside the engine (ES6a).
 *
 * `engine-core`'s `body.ts` and `magic.ts` were in this list by name until
 * `ES6a` took them into `@mmo-engine/kit-combat`, where naming them would have
 * meant naming a kit. As it turns out they had nothing left to declare — `Body`,
 * `Injury` and `Mana` became engine components in `ES5c` — but a kit of a
 * game's own can declare components, so the list is found rather than written
 * down: every source file under a `packages/kit-NAME/src` that calls
 * `defineSABComponent` has its compiled module introspected.
 *
 * A kit that has not been built yet fails the run by name rather than being
 * skipped, because a graph missing a kit's components would still look valid.
 */
export function kitIntrospectModules(repoRoot: string): IntrospectModuleSpec[] {
  const found: IntrospectModuleSpec[] = [];
  for (const srcDir of kitSrcDirs(repoRoot)) {
    for (const abs of walkFiles(srcDir, (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))) {
      if (!readFileSync(abs, "utf8").includes("defineSABComponent(")) continue;
      const relSource = toPosixPath(relative(repoRoot, abs));
      found.push({
        modulePath: relSource.replace(/^(packages\/[^/]+)\/src\//, "$1/dist/src/").replace(/\.ts$/, ".js"),
        relSource,
      });
    }
  }
  return found.sort((a, b) => (a.relSource < b.relSource ? -1 : a.relSource > b.relSource ? 1 : 0));
}

/** The engine's components plus every installed kit's. */
export function defaultIntrospectModules(repoRoot: string): IntrospectModuleSpec[] {
  return [...ENGINE_INTROSPECT_MODULES, ...kitIntrospectModules(repoRoot)];
}

export const DEFAULT_ADD_COMPONENT_PATH = "packages/engine-core/dist/src/admin/add-component.js";

/**
 * Introspect live compiled bitECS component definitions inside an isolated
 * Node child process so the graphify process never inherits engine SAB heaps.
 */
export function introspectComponents(options: IntrospectOptions): IntrospectionResult {
  const runnerPath = fileURLToPath(new URL("./introspect-runner.js", import.meta.url));
  if (!existsSync(runnerPath)) {
    throw new Error(`graphify introspect runner missing at ${runnerPath}; run tsc build first.`);
  }

  const modules = options.modules ?? defaultIntrospectModules(options.repoRoot);
  for (const m of modules) {
    const abs = resolve(options.repoRoot, m.modulePath);
    if (!existsSync(abs)) {
      const pkg = /^packages\/([^/]+)\//.exec(m.modulePath)?.[1] ?? "the package";
      throw new Error(`Compiled component module missing at ${abs}; compile @mmo-engine/${pkg} before running graphify.`);
    }
  }

  const addComponentAbs = options.addComponentPath
    ? resolve(options.repoRoot, options.addComponentPath)
    : resolve(options.repoRoot, DEFAULT_ADD_COMPONENT_PATH);
  const resolvedAddComponentPath = existsSync(addComponentAbs) ? addComponentAbs : undefined;

  const payload = JSON.stringify({
    repoRoot: options.repoRoot,
    modules,
    addComponentPath: resolvedAddComponentPath,
  });

  const stdout = execFileSync(process.execPath, [runnerPath], {
    cwd: options.repoRoot,
    input: payload,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  return JSON.parse(stdout) as IntrospectionResult;
}
