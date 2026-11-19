import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export const DEFAULT_INTROSPECT_MODULES: readonly IntrospectModuleSpec[] = [
  {
    modulePath: "packages/engine-core/dist/src/components.js",
    relSource: "packages/engine-core/src/components.ts",
  },
  {
    modulePath: "packages/engine-core/dist/src/body.js",
    relSource: "packages/engine-core/src/body.ts",
  },
  {
    modulePath: "packages/engine-core/dist/src/magic.js",
    relSource: "packages/engine-core/src/magic.ts",
  },
];

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

  const modules = options.modules ?? DEFAULT_INTROSPECT_MODULES;
  for (const m of modules) {
    const abs = resolve(options.repoRoot, m.modulePath);
    if (!existsSync(abs)) {
      throw new Error(
        `Compiled component module missing at ${abs}; compile @mmo-engine/engine-core before running graphify.`,
      );
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
