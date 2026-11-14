import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as ts from "typescript";
import { discoverModules, readEnabledSet, resolveModuleSet } from "@mmo-engine/modules";
import type { IntrospectedComponent } from "./introspect.js";
import { ROSTER_TO_CLASS_HINTS, SYSTEM_ROLES } from "./roles.js";
import {
  toPosixPath,
  type CoverageEntry,
  type GraphEdge,
  type GraphNode,
  type SystemRole,
  type UnresolvedSite,
} from "./schema.js";

export interface DeclaredAccessEntry {
  system: string;
  reads: Array<string | { component: string; fields: string[] }>;
  writes: Array<string | { component: string; fields: string[] }>;
  excludes: string[];
  source: string;
}

export interface RosterSystemInfo {
  rosterName: string;
  moduleName: string;
  tickIndex: number;
  simName: string;
  className?: string;
  role: SystemRole;
  sourceFileRel?: string;
  declared: boolean;
}

export interface AstExtractionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: UnresolvedSite[];
  coverage: CoverageEntry[];
  roster: RosterSystemInfo[];
  declaredDeclarations: Array<{
    rosterName: string;
    expectedSimName?: string;
    declaration: DeclaredAccessEntry;
  }>;
  sceneComponentRealization: Map<string, { components: string[]; source: string }>;
  protocolFieldRows: Map<string, string[]>;
  trackedSourceFiles: string[];
}

interface ParsedAccessBlock {
  system: string;
  reads: Array<string | { component: string; fields: string[] }>;
  writes: Array<string | { component: string; fields: string[] }>;
  excludes: string[];
  source: string;
}

interface ParsedClassOrObj {
  className: string;
  simName: string;
  node: ts.ClassDeclaration | ts.ObjectLiteralExpression;
  sf: ts.SourceFile;
  relPath: string;
  line: number;
  declaredAccess?: ParsedAccessBlock;
}

interface FileAnalysisContext {
  sf: ts.SourceFile;
  relPath: string;
  knownComponents: ReadonlyMap<string, IntrospectedComponent>;
  directAliases: Map<string, string>;
  namespaceIds: Set<string>;
  helperFns: Map<string, ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction>;
  moduleQueries: Map<string, ts.CallExpression>;
}

export function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

export function parseSourceFile(absPath: string): ts.SourceFile {
  const text = readFileSync(absPath, "utf8");
  return ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, scriptKindForPath(absPath));
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function siteOf(relPath: string, sf: ts.SourceFile, node: ts.Node): string {
  return `${toPosixPath(relPath)}:${lineOf(sf, node)}`;
}

function walkFiles(dir: string, predicate: (filePath: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const entry of readdirSync(cur).sort()) {
      const full = join(cur, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
        stack.push(full);
      } else if (st.isFile() && predicate(full)) {
        results.push(full);
      }
    }
  }
  return results.sort();
}

function readStringLiteral(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
    return readStringLiteral(node.expression);
  }
  return undefined;
}

function readStringArrayLiteral(node: ts.Node | undefined): string[] | undefined {
  if (!node) return undefined;
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
    return readStringArrayLiteral(node.expression);
  }
  if (!ts.isArrayLiteralExpression(node)) return undefined;
  const out: string[] = [];
  for (const el of node.elements) {
    const s = readStringLiteral(el);
    if (s !== undefined) out.push(s);
  }
  return out;
}

function getPropertyAssignment(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
        ? prop.name.text
        : undefined;
    if (name === key) return prop.initializer;
  }
  return undefined;
}

function parseAccessObjectLiteral(
  obj: ts.ObjectLiteralExpression,
  sf: ts.SourceFile,
  relPath: string,
): ParsedAccessBlock | undefined {
  const sysName = readStringLiteral(getPropertyAssignment(obj, "system"));
  if (!sysName) return undefined;

  const parseRefArray = (
    expr: ts.Expression | undefined,
  ): Array<string | { component: string; fields: string[] }> => {
    if (!expr) return [];
    let target: ts.Expression = expr;
    while (
      ts.isAsExpression(target) ||
      ts.isSatisfiesExpression(target) ||
      ts.isParenthesizedExpression(target)
    ) {
      target = target.expression;
    }
    if (!ts.isArrayLiteralExpression(target)) return [];
    const out: Array<string | { component: string; fields: string[] }> = [];
    for (const el of target.elements) {
      const str = readStringLiteral(el);
      if (str !== undefined) {
        out.push(str);
        continue;
      }
      if (ts.isObjectLiteralExpression(el)) {
        const comp = readStringLiteral(getPropertyAssignment(el, "component"));
        const fields = readStringArrayLiteral(getPropertyAssignment(el, "fields"));
        if (comp && fields) {
          out.push({ component: comp, fields });
        }
      }
    }
    return out;
  };

  return {
    system: sysName,
    reads: parseRefArray(getPropertyAssignment(obj, "reads")),
    writes: parseRefArray(getPropertyAssignment(obj, "writes")),
    excludes: readStringArrayLiteral(getPropertyAssignment(obj, "excludes")) ?? [],
    source: siteOf(relPath, sf, obj),
  };
}

function parseSystemAccessJson(filePath: string, relPath: string): ParsedAccessBlock[] {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  const items: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { systems?: unknown[] }).systems)
      ? (raw as { systems: unknown[] }).systems
      : [raw];
  const out: ParsedAccessBlock[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as {
      system?: unknown;
      reads?: unknown;
      writes?: unknown;
      excludes?: unknown;
    };
    if (typeof obj.system !== "string") continue;
    const normRefs = (arr: unknown): Array<string | { component: string; fields: string[] }> => {
      if (!Array.isArray(arr)) return [];
      const res: Array<string | { component: string; fields: string[] }> = [];
      for (const el of arr) {
        if (typeof el === "string") res.push(el);
        else if (
          el &&
          typeof el === "object" &&
          typeof (el as { component?: unknown }).component === "string" &&
          Array.isArray((el as { fields?: unknown }).fields)
        ) {
          res.push({
            component: (el as { component: string }).component,
            fields: ((el as { fields: unknown[] }).fields).filter(
              (f): f is string => typeof f === "string",
            ),
          });
        }
      }
      return res;
    };
    out.push({
      system: obj.system,
      reads: normRefs(obj.reads),
      writes: normRefs(obj.writes),
      excludes: Array.isArray(obj.excludes)
        ? obj.excludes.filter((x): x is string => typeof x === "string")
        : [],
      source: `${toPosixPath(relPath)}:1`,
    });
  }
  return out;
}

function collectFileContext(
  repoRoot: string,
  absPath: string,
  knownComponents: ReadonlyMap<string, IntrospectedComponent>,
): FileAnalysisContext {
  const sf = parseSourceFile(absPath);
  const relPath = toPosixPath(relative(repoRoot, absPath));
  const directAliases = new Map<string, string>();
  const namespaceIds = new Set<string>();
  const helperFns = new Map<string, ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction>();
  const moduleQueries = new Map<string, ts.CallExpression>();

  for (const name of knownComponents.keys()) {
    // Only seed direct file-local component names if declared as top-level exported const in same file.
    for (const st of sf.statements) {
      if (ts.isVariableStatement(st)) {
        for (const decl of st.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === name) {
            directAliases.set(name, name);
          }
        }
      }
    }
  }

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause) {
      const clause = st.importClause;
      if (clause.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const spec of clause.namedBindings.elements) {
            const exportedName = spec.propertyName ? spec.propertyName.text : spec.name.text;
            if (knownComponents.has(exportedName)) {
              directAliases.set(spec.name.text, exportedName);
            }
          }
        } else if (ts.isNamespaceImport(clause.namedBindings)) {
          const modText = readStringLiteral(st.moduleSpecifier) ?? "";
          if (
            modText.includes("components") ||
            modText.includes("body") ||
            modText.includes("magic") ||
            modText.includes("engine-core")
          ) {
            namespaceIds.add(clause.namedBindings.name.text);
          }
        }
      }
    } else if (ts.isFunctionDeclaration(st) && st.name) {
      helperFns.set(st.name.text, st);
    } else if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        if (ts.isFunctionExpression(decl.initializer) || ts.isArrowFunction(decl.initializer)) {
          helperFns.set(decl.name.text, decl.initializer);
        } else if (
          ts.isCallExpression(decl.initializer) &&
          ts.isIdentifier(decl.initializer.expression) &&
          decl.initializer.expression.text === "defineQuery"
        ) {
          moduleQueries.set(decl.name.text, decl.initializer);
        } else if (ts.isIdentifier(decl.initializer) && directAliases.has(decl.initializer.text)) {
          directAliases.set(decl.name.text, directAliases.get(decl.initializer.text)!);
        } else if (
          ts.isPropertyAccessExpression(decl.initializer) &&
          ts.isIdentifier(decl.initializer.expression) &&
          namespaceIds.has(decl.initializer.expression.text) &&
          knownComponents.has(decl.initializer.name.text)
        ) {
          directAliases.set(decl.name.text, decl.initializer.name.text);
        }
      }
    }
  }

  return { sf, relPath, knownComponents, directAliases, namespaceIds, helperFns, moduleQueries };
}

function resolveComponentExpr(
  expr: ts.Expression,
  localAliases: ReadonlyMap<string, string>,
  ctx: FileAnalysisContext,
): string | undefined {
  let target = expr;
  while (
    ts.isParenthesizedExpression(target) ||
    ts.isNonNullExpression(target) ||
    ts.isAsExpression(target)
  ) {
    target = target.expression;
  }
  if (ts.isIdentifier(target)) {
    return localAliases.get(target.text) ?? ctx.directAliases.get(target.text);
  }
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
    if (ctx.namespaceIds.has(target.expression.text) && ctx.knownComponents.has(target.name.text)) {
      return target.name.text;
    }
  }
  return undefined;
}

function isWriteAssignmentParent(node: ts.Node): { read: boolean; write: boolean } {
  let cur: ts.Node = node;
  while (
    cur.parent &&
    (ts.isParenthesizedExpression(cur.parent) ||
      ts.isNonNullExpression(cur.parent) ||
      ts.isAsExpression(cur.parent))
  ) {
    cur = cur.parent;
  }
  const parent = cur.parent;
  if (!parent) return { read: true, write: false };

  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    if (
      parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken
    ) {
      return { read: true, write: true };
    }
  }

  if (ts.isBinaryExpression(parent) && parent.left === cur) {
    const op = parent.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsToken) {
      return { read: false, write: true };
    }
    if (
      op === ts.SyntaxKind.PlusEqualsToken ||
      op === ts.SyntaxKind.MinusEqualsToken ||
      op === ts.SyntaxKind.AsteriskEqualsToken ||
      op === ts.SyntaxKind.SlashEqualsToken ||
      op === ts.SyntaxKind.PercentEqualsToken ||
      op === ts.SyntaxKind.BarEqualsToken ||
      op === ts.SyntaxKind.AmpersandEqualsToken ||
      op === ts.SyntaxKind.CaretEqualsToken ||
      op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
    ) {
      return { read: true, write: true };
    }
  }

  return { read: true, write: false };
}

interface AnalyzedUsage {
  queryComponents: Array<{ component: string; source: string }>;
  excludes: Array<{ component: string; source: string }>;
  componentReads: Array<{ component: string; source: string }>;
  componentWrites: Array<{ component: string; source: string }>;
  fieldReads: Array<{ component: string; field: string; source: string }>;
  fieldWrites: Array<{ component: string; field: string; source: string }>;
  unresolved: UnresolvedSite[];
}

function createsLexicalScope(n: ts.Node): boolean {
  return (
    ts.isBlock(n) ||
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isForOfStatement(n) ||
    ts.isForStatement(n) ||
    ts.isForInStatement(n)
  );
}

function analyzeAstSubtrees(
  roots: readonly ts.Node[],
  ctx: FileAnalysisContext,
  systemId: string,
  followHelpers: boolean,
): AnalyzedUsage {
  const result: AnalyzedUsage = {
    queryComponents: [],
    excludes: [],
    componentReads: [],
    componentWrites: [],
    fieldReads: [],
    fieldWrites: [],
    unresolved: [],
  };

  const visitedFns = new Set<ts.Node>();
  const analyzedModuleQueries = new Set<string>();
  const queue: ts.Node[] = [...roots];

  const handleDefineQuery = (
    callExpr: ts.CallExpression,
    localAliases: Map<string, string>,
  ): void => {
    const arg = callExpr.arguments[0];
    if (!arg) return;
    let target: ts.Expression = arg;
    while (ts.isParenthesizedExpression(target) || ts.isAsExpression(target)) {
      target = target.expression;
    }
    if (!ts.isArrayLiteralExpression(target)) {
      result.unresolved.push({
        system: systemId,
        site: siteOf(ctx.relPath, ctx.sf, callExpr),
        reason: "defineQuery argument is not an array literal",
        expression: callExpr.getText(ctx.sf).slice(0, 120),
      });
      return;
    }
    for (const el of target.elements) {
      if (
        ts.isCallExpression(el) &&
        ts.isIdentifier(el.expression) &&
        el.expression.text === "Not" &&
        el.arguments.length >= 1
      ) {
        const comp = resolveComponentExpr(el.arguments[0], localAliases, ctx);
        if (comp) {
          result.excludes.push({ component: comp, source: siteOf(ctx.relPath, ctx.sf, el) });
        } else {
          result.unresolved.push({
            system: systemId,
            site: siteOf(ctx.relPath, ctx.sf, el),
            reason: "Not(...) target could not be resolved to an ECS component",
            expression: el.getText(ctx.sf).slice(0, 120),
          });
        }
        continue;
      }
      const comp = resolveComponentExpr(el, localAliases, ctx);
      if (comp) {
        result.queryComponents.push({ component: comp, source: siteOf(ctx.relPath, ctx.sf, el) });
      } else {
        result.unresolved.push({
          system: systemId,
          site: siteOf(ctx.relPath, ctx.sf, el),
          reason: "defineQuery term could not be resolved statically to an ECS component",
          expression: el.getText(ctx.sf).slice(0, 120),
        });
      }
    }
  };

  while (queue.length > 0) {
    const root = queue.shift()!;
    if (visitedFns.has(root)) continue;
    visitedFns.add(root);

    const walk = (
      n: ts.Node,
      localAliases: Map<string, string>,
      loopListVars: Map<string, string[]>,
    ): void => {
      const nextAliases = createsLexicalScope(n) ? new Map(localAliases) : localAliases;
      const nextLoops = createsLexicalScope(n) ? new Map(loopListVars) : loopListVars;

      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const comp = resolveComponentExpr(n.initializer, nextAliases, ctx);
        if (comp) nextAliases.set(n.name.text, comp);
      }

      if (
        ts.isForOfStatement(n) &&
        ts.isVariableDeclarationList(n.initializer) &&
        n.initializer.declarations.length === 1 &&
        ts.isIdentifier(n.initializer.declarations[0].name) &&
        ts.isArrayLiteralExpression(n.expression)
      ) {
        const varName = n.initializer.declarations[0].name.text;
        const comps: string[] = [];
        for (const el of n.expression.elements) {
          const c = resolveComponentExpr(el, nextAliases, ctx);
          if (c) comps.push(c);
        }
        if (comps.length > 0) {
          nextLoops.set(varName, comps);
        }
      }

      if (ts.isCallExpression(n)) {
        // Call to module-level query function like `playerQuery(sim.ecs)`
        if (ts.isIdentifier(n.expression)) {
          const fnName = n.expression.text;
          if (fnName === "defineQuery") {
            handleDefineQuery(n, nextAliases);
          } else if (ctx.moduleQueries.has(fnName) && !analyzedModuleQueries.has(fnName)) {
            analyzedModuleQueries.add(fnName);
            handleDefineQuery(ctx.moduleQueries.get(fnName)!, new Map(ctx.directAliases));
          } else if (
            (fnName === "hasComponent" || fnName === "addComponent" || fnName === "removeComponent") &&
            n.arguments.length >= 2
          ) {
            const compArg = n.arguments[1];
            const resolved = resolveComponentExpr(compArg, nextAliases, ctx);
            const src = siteOf(ctx.relPath, ctx.sf, n);
            if (resolved) {
              if (fnName === "hasComponent") result.componentReads.push({ component: resolved, source: src });
              else result.componentWrites.push({ component: resolved, source: src });
            } else if (ts.isIdentifier(compArg) && nextLoops.has(compArg.text)) {
              for (const lc of nextLoops.get(compArg.text)!) {
                if (fnName === "hasComponent") result.componentReads.push({ component: lc, source: src });
                else result.componentWrites.push({ component: lc, source: src });
              }
            } else {
              result.unresolved.push({
                system: systemId,
                site: src,
                reason: `${fnName} component argument resolved dynamically`,
                expression: n.getText(ctx.sf).slice(0, 120),
              });
            }
          } else if (followHelpers && ctx.helperFns.has(fnName)) {
            const helper = ctx.helperFns.get(fnName)!;
            if (!visitedFns.has(helper)) queue.push(helper);
          }
        }
      }

      // Direct field access: Comp.field[eid] or NS.Comp.field[eid] or Alias.field[eid]
      if (ts.isElementAccessExpression(n)) {
        if (ts.isPropertyAccessExpression(n.expression)) {
          const fieldName = n.expression.name.text;
          const baseComp = resolveComponentExpr(n.expression.expression, nextAliases, ctx);
          if (baseComp) {
            const schema = ctx.knownComponents.get(baseComp);
            const hasField = schema?.fields.some((f) => f.name === fieldName) ?? false;
            const src = siteOf(ctx.relPath, ctx.sf, n);
            if (hasField) {
              const { read, write } = isWriteAssignmentParent(n);
              if (read) result.fieldReads.push({ component: baseComp, field: fieldName, source: src });
              if (write) result.fieldWrites.push({ component: baseComp, field: fieldName, source: src });
            } else {
              result.unresolved.push({
                system: systemId,
                site: src,
                reason: `unknown or dynamic field "${fieldName}" on component ${baseComp}`,
                expression: n.getText(ctx.sf).slice(0, 120),
              });
            }
          }
        } else if (ts.isElementAccessExpression(n.expression)) {
          // Comp[dynKey][eid]
          const baseComp = resolveComponentExpr(n.expression.expression, nextAliases, ctx);
          if (baseComp) {
            result.unresolved.push({
              system: systemId,
              site: siteOf(ctx.relPath, ctx.sf, n),
              reason: `computed property indexing on component ${baseComp}`,
              expression: n.getText(ctx.sf).slice(0, 120),
            });
          }
        }
      }

      ts.forEachChild(n, (child) => walk(child, nextAliases, nextLoops));
    };

    walk(root, new Map(ctx.directAliases), new Map());
  }

  return result;
}

function findSimSystemClasses(
  repoRoot: string,
  absPath: string,
): ParsedClassOrObj[] {
  const sf = parseSourceFile(absPath);
  const relPath = toPosixPath(relative(repoRoot, absPath));
  const out: ParsedClassOrObj[] = [];

  for (const st of sf.statements) {
    if (!ts.isClassDeclaration(st) || !st.name) continue;
    const implementsSim = st.heritageClauses?.some(
      (hc) =>
        hc.token === ts.SyntaxKind.ImplementsKeyword &&
        hc.types.some((t) => t.expression.getText(sf) === "SimSystem"),
    );
    if (!implementsSim) continue;

    let simName = st.name.text;
    let declaredAccess: ParsedAccessBlock | undefined;
    for (const member of st.members) {
      if (!ts.isPropertyDeclaration(member) || !member.initializer) continue;
      const propName = ts.isIdentifier(member.name) ? member.name.text : undefined;
      if (propName === "name") {
        const s = readStringLiteral(member.initializer);
        if (s) simName = s;
      } else if (propName === "access" && ts.isObjectLiteralExpression(member.initializer)) {
        declaredAccess = parseAccessObjectLiteral(member.initializer, sf, relPath);
      }
    }

    out.push({
      className: st.name.text,
      simName,
      node: st,
      sf,
      relPath,
      line: lineOf(sf, st),
      declaredAccess,
    });
  }
  return out;
}

function parseServerModuleClassBindings(
  repoRoot: string,
  moduleDir: string,
  serverEntry: string,
): Map<string, { className: string; tsSourceRel: string }> {
  const absEntry = resolve(moduleDir, serverEntry);
  const bindings = new Map<string, { className: string; tsSourceRel: string }>();
  if (!existsSync(absEntry)) return bindings;

  const sf = parseSourceFile(absEntry);
  const entryRel = toPosixPath(relative(repoRoot, absEntry));

  // Map imported symbols -> candidate TS source file path
  const importMap = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings) continue;
    if (!ts.isNamedImports(st.importClause.namedBindings)) continue;
    const modPath = readStringLiteral(st.moduleSpecifier);
    if (!modPath) continue;
    const resolvedJs = resolve(dirname(absEntry), modPath);
    let sourcePath = resolvedJs;
    // Translate ../../packages/engine-core/dist/src/X.js -> packages/engine-core/src/X.ts
    const normResolved = toPosixPath(relative(repoRoot, resolvedJs));
    const m = normResolved.match(/^(packages\/[^/]+)\/dist\/(src\/.+)\.js$/);
    if (m) {
      const candidateTs = resolve(repoRoot, m[1], `${m[2]}.ts`);
      if (existsSync(candidateTs)) sourcePath = candidateTs;
    }
    const relSource = toPosixPath(relative(repoRoot, sourcePath));
    for (const el of st.importClause.namedBindings.elements) {
      const orig = el.propertyName ? el.propertyName.text : el.name.text;
      importMap.set(el.name.text, `${relSource}::${orig}`);
    }
  }

  // Track variable initializers inside createSystems: `const foo = new FooSystem(...)`
  const varToClass = new Map<string, { className: string; tsSourceRel: string }>();
  const walk = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      if (ts.isNewExpression(n.initializer) && ts.isIdentifier(n.initializer.expression)) {
        const localCtor = n.initializer.expression.text;
        const imp = importMap.get(localCtor);
        if (imp) {
          const [relSrc, orig] = imp.split("::");
          varToClass.set(n.name.text, { className: orig, tsSourceRel: relSrc });
        } else {
          varToClass.set(n.name.text, { className: localCtor, tsSourceRel: entryRel });
        }
      }
    }
    if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression)) {
      for (const prop of n.expression.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) {
          const b = varToClass.get(prop.name.text);
          if (b) bindings.set(prop.name.text, b);
        } else if (ts.isPropertyAssignment(prop)) {
          const key = ts.isIdentifier(prop.name)
            ? prop.name.text
            : ts.isStringLiteral(prop.name)
              ? prop.name.text
              : undefined;
          if (!key) continue;
          if (ts.isIdentifier(prop.initializer)) {
            const b = varToClass.get(prop.initializer.text);
            if (b) bindings.set(key, b);
          } else if (
            ts.isNewExpression(prop.initializer) &&
            ts.isIdentifier(prop.initializer.expression)
          ) {
            const ctor = prop.initializer.expression.text;
            const imp = importMap.get(ctor);
            if (imp) {
              const [relSrc, orig] = imp.split("::");
              bindings.set(key, { className: orig, tsSourceRel: relSrc });
            }
          }
        }
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return bindings;
}

export function extractAllFromAst(
  repoRoot: string,
  introspected: readonly IntrospectedComponent[],
  options?: { engineVersion?: string },
): AstExtractionResult {
  const knownComponents = new Map<string, IntrospectedComponent>();
  const lowerComponents = new Map<string, string>();
  for (const c of introspected) {
    knownComponents.set(c.name, c);
    lowerComponents.set(c.name.toLowerCase(), c.name);
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const unresolved: UnresolvedSite[] = [];
  const coverage: CoverageEntry[] = [];
  const declaredDeclarations: AstExtractionResult["declaredDeclarations"] = [];
  const trackedSet = new Set<string>();

  const enginePkgPath = resolve(repoRoot, "packages/engine-core/package.json");
  const engineVersion =
    options?.engineVersion ??
    (existsSync(enginePkgPath)
      ? (JSON.parse(readFileSync(enginePkgPath, "utf8")) as { version: string }).version
      : "0.1.0");

  // S6: Discover & resolve enabled modules + tick roster
  const modulesDir = resolve(repoRoot, "modules");
  const modulesJsonPath = resolve(repoRoot, "content/modules.json");
  const moduleAccessByRoster = new Map<string, ParsedAccessBlock>();
  const serverBindingsByRoster = new Map<string, { className: string; tsSourceRel: string }>();
  const resolvedModulesInfo: Array<{
    name: string;
    version?: string;
    description?: string;
    entry?: string;
    systems: string[];
    source: string;
  }> = [];
  const resolvedTickRoster: Array<{ name: string; module: string; tickIndex: number }> = [];

  if (existsSync(modulesDir) && existsSync(modulesJsonPath)) {
    trackedSet.add("content/modules.json");
    const enabled = readEnabledSet(modulesJsonPath);
    const found = discoverModules(modulesDir, engineVersion);
    const resolved = resolveModuleSet(found.valid, enabled.modules);
    if (!resolved.ok) {
      const msg = resolved.problems.map((p) => `${p.module}: ${p.message}`).join("; ");
      throw new Error(`graphify failed to resolve module set: ${msg}`);
    }

    for (const mod of resolved.modules) {
      const modRel = toPosixPath(relative(repoRoot, join(mod.dir, "module.json")));
      trackedSet.add(modRel);
      const sysList = (mod.manifest.server?.systems ?? []).map((s) => s.name);
      const serverEntry = mod.manifest.server?.entry;
      resolvedModulesInfo.push({
        name: mod.manifest.name,
        version: mod.manifest.version,
        description: mod.manifest.description,
        entry: serverEntry,
        systems: sysList,
        source: modRel,
      });

      nodes.push({
        id: `module:${mod.manifest.name}`,
        kind: "module",
        name: mod.manifest.name,
        ...(mod.manifest.version ? { version: mod.manifest.version } : {}),
        ...(mod.manifest.description ? { description: mod.manifest.description } : {}),
        ...(serverEntry ? { entry: serverEntry } : {}),
        systems: sysList,
        source: modRel,
      });

      if (serverEntry) {
        const entryRel = toPosixPath(relative(repoRoot, resolve(mod.dir, serverEntry)));
        if (existsSync(resolve(mod.dir, serverEntry))) trackedSet.add(entryRel);
        const bindings = parseServerModuleClassBindings(repoRoot, mod.dir, serverEntry);
        for (const [k, v] of bindings) serverBindingsByRoster.set(k, v);
      }

      const accessJsonPath = join(mod.dir, "system-access.json");
      if (existsSync(accessJsonPath)) {
        const relAcc = toPosixPath(relative(repoRoot, accessJsonPath));
        trackedSet.add(relAcc);
        for (const block of parseSystemAccessJson(accessJsonPath, relAcc)) {
          moduleAccessByRoster.set(block.system, block);
        }
      }
    }

    for (let i = 0; i < resolved.systems.length; i++) {
      const s = resolved.systems[i];
      resolvedTickRoster.push({ name: s.name, module: s.module, tickIndex: i });
    }
    coverage.push({
      source: "modules/*/module.json",
      status: "extracted",
      count: resolved.modules.length,
      details: `${resolved.modules.length} enabled modules contributing ${resolved.systems.length} ordered tick systems`,
    });
  }

  // S3 & S4: Scan TS sources for SimSystem classes and module-level queries
  const engineSrcDir = resolve(repoRoot, "packages/engine-core/src");
  const tsFiles = walkFiles(
    engineSrcDir,
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"),
  );
  const allSimClasses: ParsedClassOrObj[] = [];
  const fileContexts = new Map<string, FileAnalysisContext>();
  for (const abs of tsFiles) {
    const rel = toPosixPath(relative(repoRoot, abs));
    trackedSet.add(rel);
    const ctx = collectFileContext(repoRoot, abs, knownComponents);
    fileContexts.set(rel, ctx);
    for (const c of findSimSystemClasses(repoRoot, abs)) {
      allSimClasses.push(c);
    }
  }

  // Also index module `server.js` files that define inline systems
  const classByName = new Map<string, ParsedClassOrObj>();
  const classesBySimName = new Map<string, ParsedClassOrObj[]>();
  for (const c of allSimClasses) {
    classByName.set(c.className, c);
    const list = classesBySimName.get(c.simName) ?? [];
    list.push(c);
    classesBySimName.set(c.simName, list);
  }

  const roster: RosterSystemInfo[] = [];
  const attributedFiles = new Set<string>();
  const rosterIds = new Set<string>();

  for (const entry of resolvedTickRoster) {
    const role: SystemRole | undefined = SYSTEM_ROLES[entry.name];
    if (!role) {
      throw new Error(
        `Tick roster system "${entry.name}" (module "${entry.module}") is missing a reviewed role in packages/graphify/src/roles.ts`,
      );
    }

    const hint = ROSTER_TO_CLASS_HINTS[entry.name];
    const binding = serverBindingsByRoster.get(entry.name);
    let matched: ParsedClassOrObj | undefined;
    if (binding && classByName.has(binding.className)) {
      matched = classByName.get(binding.className);
    } else if (hint && classByName.has(hint.className)) {
      matched = classByName.get(hint.className);
    } else {
      const candidates = classesBySimName.get(entry.name) ?? [];
      // Prefer non-native primary implementation if both Native* and JS exist
      matched = candidates.find((c) => !c.className.startsWith("Native")) ?? candidates[0];
    }

    const modAccess = moduleAccessByRoster.get(entry.name);
    const declaredAccess = matched?.declaredAccess ?? modAccess;
    const isDeclared = declaredAccess !== undefined;
    const sysId = `system:${entry.name}`;
    rosterIds.add(sysId);

    const modRelSource = `modules/${entry.module}/module.json`;
    const sysSource = matched ? `${matched.relPath}:${matched.line}` : `${modRelSource}:1`;
    if (matched) attributedFiles.add(matched.relPath);

    nodes.push({
      id: sysId,
      kind: "system",
      name: entry.name,
      simName: matched?.simName ?? hint?.simName ?? entry.name,
      ...(matched ? { className: matched.className } : hint ? { className: hint.className } : {}),
      role,
      module: entry.module,
      tickIndex: entry.tickIndex,
      declared: isDeclared,
      inRoster: true,
      source: sysSource,
    });

    edges.push({
      from: sysId,
      to: `module:${entry.module}`,
      kind: "contributedBy",
      confidence: "introspected",
      source: modRelSource,
    });

    roster.push({
      rosterName: entry.name,
      moduleName: entry.module,
      tickIndex: entry.tickIndex,
      simName: matched?.simName ?? hint?.simName ?? entry.name,
      className: matched?.className ?? hint?.className,
      role,
      sourceFileRel: matched?.relPath,
      declared: isDeclared,
    });

    if (declaredAccess) {
      declaredDeclarations.push({
        rosterName: entry.name,
        expectedSimName: matched?.simName,
        declaration: declaredAccess,
      });
      emitDeclaredAccessEdges(sysId, declaredAccess, edges);
    }

    if (matched) {
      const ctx = fileContexts.get(matched.relPath)!;
      const usage = analyzeAstSubtrees([matched.node], ctx, entry.name, true);
      unresolved.push(...usage.unresolved);
      emitUsageEdges(sysId, usage, declaredAccess, edges);
    }
  }

  // Extract infrastructure query consumers from unattributed files with defineQuery
  // (e.g. snapshot.ts, net/interest.ts, net/gateway.ts, net/debug-source.ts, admin/find.ts).
  for (const [relPath, ctx] of [...fileContexts.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    if (attributedFiles.has(relPath)) continue;
    if (relPath.endsWith("native-systems.ts")) continue; // variant native shims covered by H4 specs
    const queryCalls = findAllDefineQueryNodes(ctx.sf);
    if (queryCalls.length === 0) continue;

    const base = relPath
      .replace(/^packages\/engine-core\/src\//, "")
      .replace(/\.ts$/, "")
      .replace(/[\/_]/g, "-");
    const sysName = `infra-${base}`;
    const sysId = `system:${sysName}`;

    nodes.push({
      id: sysId,
      kind: "system",
      name: sysName,
      role: "infrastructure",
      declared: false,
      inRoster: false,
      source: `${relPath}:${lineOf(ctx.sf, queryCalls[0])}`,
    });

    const usage = analyzeAstSubtrees([ctx.sf], ctx, sysName, false);
    unresolved.push(...usage.unresolved);
    emitUsageEdges(sysId, usage, undefined, edges);
  }

  coverage.push({
    source: "packages/engine-core/src/** (systems & queries)",
    status: "extracted",
    count: roster.length,
    details: `${roster.filter((r) => r.declared).length} declared / ${roster.length} tick-roster systems extracted via TS AST`,
  });

  // S8: Scene spawn realization (packages/engine-core/src/scene-spawn.ts & scatter-spawn.ts)
  const sceneComponentRealization = extractSceneRealization(
    repoRoot,
    knownComponents,
    trackedSet,
    coverage,
  );

  // S9: Authoring maps (verbs, widgets, COMPONENT_WIDGET)
  const systemIds = new Set(nodes.filter((n) => n.kind === "system").map((n) => n.id));
  const moduleIds = new Set(nodes.filter((n) => n.kind === "module").map((n) => n.id));
  extractAuthoringMaps(
    repoRoot,
    knownComponents,
    lowerComponents,
    systemIds,
    moduleIds,
    nodes,
    edges,
    trackedSet,
    coverage,
  );

  // S10: Protocol schema rows
  const protocolFieldRows = extractProtocolRows(repoRoot, knownComponents, trackedSet, coverage);

  return {
    nodes,
    edges,
    unresolved,
    coverage,
    roster,
    declaredDeclarations,
    sceneComponentRealization,
    protocolFieldRows,
    trackedSourceFiles: [...trackedSet].sort(),
  };
}

function findAllDefineQueryNodes(sf: ts.SourceFile): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const walk = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "defineQuery"
    ) {
      found.push(n);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return found;
}

function emitDeclaredAccessEdges(
  sysId: string,
  declared: ParsedAccessBlock,
  edges: GraphEdge[],
): void {
  const pushRefs = (
    refs: Array<string | { component: string; fields: string[] }>,
    kind: "reads" | "writes",
  ): void => {
    for (const ref of refs) {
      if (typeof ref === "string") {
        edges.push({
          from: sysId,
          to: `component:${ref}`,
          kind,
          confidence: "declared",
          source: declared.source,
        });
      } else {
        for (const f of ref.fields) {
          edges.push({
            from: sysId,
            to: `field:${ref.component}.${f}`,
            kind,
            confidence: "declared",
            source: declared.source,
          });
        }
      }
    }
  };
  pushRefs(declared.reads, "reads");
  pushRefs(declared.writes, "writes");
  for (const ex of declared.excludes) {
    edges.push({
      from: sysId,
      to: `component:${ex}`,
      kind: "excludes",
      confidence: "declared",
      source: declared.source,
    });
  }
}

function emitUsageEdges(
  sysId: string,
  usage: AnalyzedUsage,
  declared: ParsedAccessBlock | undefined,
  edges: GraphEdge[],
): void {
  const declaredCompReads = new Set<string>();
  const declaredCompWrites = new Set<string>();
  if (declared) {
    for (const r of declared.reads) declaredCompReads.add(typeof r === "string" ? r : r.component);
    for (const w of declared.writes) declaredCompWrites.add(typeof w === "string" ? w : w.component);
  }

  const fieldReadComps = new Set<string>(declaredCompReads);
  const fieldWriteComps = new Set<string>(declaredCompWrites);

  for (const fr of usage.fieldReads) {
    fieldReadComps.add(fr.component);
    if (!declaredCompReads.has(fr.component)) {
      edges.push({
        from: sysId,
        to: `field:${fr.component}.${fr.field}`,
        kind: "reads",
        confidence: "extracted",
        source: fr.source,
      });
    }
  }
  for (const fw of usage.fieldWrites) {
    fieldWriteComps.add(fw.component);
    if (!declaredCompWrites.has(fw.component)) {
      edges.push({
        from: sysId,
        to: `field:${fw.component}.${fw.field}`,
        kind: "writes",
        confidence: "extracted",
        source: fw.source,
      });
    }
  }

  for (const cr of usage.componentReads) {
    if (!fieldReadComps.has(cr.component)) {
      edges.push({
        from: sysId,
        to: `component:${cr.component}`,
        kind: "reads",
        confidence: "extracted",
        source: cr.source,
      });
    }
  }
  for (const cw of usage.componentWrites) {
    if (!declaredCompWrites.has(cw.component)) {
      edges.push({
        from: sysId,
        to: `component:${cw.component}`,
        kind: "writes",
        confidence: "extracted",
        source: cw.source,
      });
    }
  }

  // Per §5.2: Query-only components with no field R/W found emit component-level `inferred` reads
  for (const q of usage.queryComponents) {
    if (!fieldReadComps.has(q.component) && !fieldWriteComps.has(q.component)) {
      edges.push({
        from: sysId,
        to: `component:${q.component}`,
        kind: "reads",
        confidence: "inferred",
        source: q.source,
      });
    }
  }

  for (const ex of usage.excludes) {
    edges.push({
      from: sysId,
      to: `component:${ex.component}`,
      kind: "excludes",
      confidence: "extracted",
      source: ex.source,
    });
  }
}

function extractSceneRealization(
  repoRoot: string,
  knownComponents: ReadonlyMap<string, IntrospectedComponent>,
  trackedSet: Set<string>,
  coverage: CoverageEntry[],
): Map<string, { components: string[]; source: string }> {
  const result = new Map<string, { components: string[]; source: string }>();
  const sceneSpawnRel = "packages/engine-core/src/scene-spawn.ts";
  const sceneSpawnAbs = resolve(repoRoot, sceneSpawnRel);
  const scatterSpawnRel = "packages/engine-core/src/procgen/scatter-spawn.ts";
  const scatterSpawnAbs = resolve(repoRoot, scatterSpawnRel);

  if (!existsSync(sceneSpawnAbs)) return result;
  trackedSet.add(sceneSpawnRel);
  const sf = parseSourceFile(sceneSpawnAbs);

  // Locate exact lines where scene component properties (`node.components?.<Kind>`) are handled
  const kindLine = new Map<string, number>();
  const walk = (n: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "components"
    ) {
      const kindName = n.name.text;
      if (!kindLine.has(kindName)) kindLine.set(kindName, lineOf(sf, n));
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);

  // Inspect scatter-spawn.ts via AST for base addComponent calls (Breakable/Health are conditional per Breakable node)
  const scatterComps = new Set<string>(["Transform", "AssetRef", "Velocity", "BodyConfig"]);
  if (existsSync(scatterSpawnAbs)) {
    trackedSet.add(scatterSpawnRel);
    const scatterCtx = collectFileContext(repoRoot, scatterSpawnAbs, knownComponents);
    const scatterUsage = analyzeAstSubtrees([scatterCtx.sf], scatterCtx, "scatter-spawn", false);
    for (const cw of scatterUsage.componentWrites) {
      if (cw.component === "Health" || cw.component === "Breakable") continue;
      if (knownComponents.has(cw.component)) scatterComps.add(cw.component);
    }
  }

  const filterKnown = (list: string[]): string[] =>
    list.filter((c) => knownComponents.has(c)).sort();

  const sourceFor = (kind: string, fallback = 1): string =>
    `${sceneSpawnRel}:${kindLine.get(kind) ?? fallback}`;

  const mapping: Record<string, string[]> = {
    Structure: filterKnown([...scatterComps]),
    Collider: filterKnown(["Transform", "AssetRef", "Velocity", "BodyConfig"]),
    Breakable: filterKnown(["Health", "Breakable"]),
    ResourceNode: filterKnown(["Transform", "AssetRef", "Velocity", "BodyConfig"]),
    Chest: filterKnown(["Transform", "AssetRef", "Velocity", "BodyConfig"]),
    Door: filterKnown(["Transform", "AssetRef", "Velocity", "BodyConfig"]),
    Vendor: filterKnown(["Transform", "AssetRef", "Velocity", "BodyConfig"]),
    ItemSpawn: filterKnown(["WorldItem", "Transform", "AssetRef", "Velocity", "BodyConfig"]),
    Spawner: filterKnown([
      "Transform",
      "Velocity",
      "Health",
      "BodyConfig",
      "Locomotion",
      "NavAgent",
      "Action",
      "AssetRef",
    ]),
    QuestGiver: filterKnown(["Transform", "CharacterRef"]),
    CharacterPreview: filterKnown(["Transform", "Appearance"]),
    Light: filterKnown(["Transform"]),
  };

  for (const [kind, comps] of Object.entries(mapping)) {
    if (comps.length > 0) {
      result.set(kind, { components: comps, source: sourceFor(kind) });
    }
  }

  coverage.push({
    source: sceneSpawnRel,
    status: "extracted",
    count: result.size,
    details: `${result.size} scene component kinds mapped to live ECS components`,
  });

  return result;
}

function extractAuthoringMaps(
  repoRoot: string,
  knownComponents: ReadonlyMap<string, IntrospectedComponent>,
  lowerComponents: ReadonlyMap<string, string>,
  systemIds: ReadonlySet<string>,
  moduleIds: ReadonlySet<string>,
  nodes: GraphNode[],
  edges: GraphEdge[],
  trackedSet: Set<string>,
  coverage: CoverageEntry[],
): void {
  const verbsRel = "apps/editor/src/authoring/verbs.ts";
  const relevanceRel = "apps/editor/src/authoring/relevance.ts";
  const viewRel = "apps/editor/src/ui/authoring-view.tsx";
  const widgetsRel = "apps/editor/src/authoring/widgets.ts";

  const widgetComponents = new Map<string, Set<string>>();
  const widgetVerbs = new Map<string, Set<string>>();
  let verbsCount = 0;
  let widgetsCount = 0;

  if (existsSync(resolve(repoRoot, viewRel))) {
    trackedSet.add(viewRel);
    const sf = parseSourceFile(resolve(repoRoot, viewRel));
    const walk = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === "COMPONENT_WIDGET" &&
        n.initializer &&
        ts.isObjectLiteralExpression(n.initializer)
      ) {
        for (const prop of n.initializer.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const compLower = ts.isIdentifier(prop.name)
            ? prop.name.text
            : readStringLiteral(prop.name);
          const widgetId = readStringLiteral(prop.initializer);
          if (!compLower || !widgetId) continue;
          const canonicalComp = lowerComponents.get(compLower.toLowerCase());
          if (!canonicalComp) continue;
          const src = siteOf(viewRel, sf, prop);
          edges.push({
            from: `component:${canonicalComp}`,
            to: `widget:${widgetId}`,
            kind: "summons",
            confidence: "introspected",
            source: src,
          });
          edges.push({
            from: `widget:${widgetId}`,
            to: `component:${canonicalComp}`,
            kind: "operatesOn",
            confidence: "introspected",
            source: src,
          });
          const s = widgetComponents.get(widgetId) ?? new Set<string>();
          s.add(canonicalComp);
          widgetComponents.set(widgetId, s);
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }

  if (existsSync(resolve(repoRoot, relevanceRel))) {
    trackedSet.add(relevanceRel);
    const sf = parseSourceFile(resolve(repoRoot, relevanceRel));
    const walk = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === "WIDGET_IDS" &&
        n.initializer
      ) {
        const ids = readStringArrayLiteral(n.initializer) ?? [];
        const src = siteOf(relevanceRel, sf, n);
        for (const wid of ids) {
          widgetsCount++;
          nodes.push({
            id: `widget:${wid}`,
            kind: "widget",
            name: wid,
            ...(widgetComponents.has(wid)
              ? { components: [...widgetComponents.get(wid)!].sort() }
              : {}),
            ...(widgetVerbs.has(wid) ? { verbs: [...widgetVerbs.get(wid)!].sort() } : {}),
            source: src,
          });
        }
      }
      // Also catch explicit `if (hasComponent(facts, "Comp")) { ... push({ widgetId: "w", ... }) }`
      if (ts.isIfStatement(n)) {
        let checkedComp: string | undefined;
        let pushedWidget: string | undefined;
        const scanCond = (c: ts.Node): void => {
          if (
            ts.isCallExpression(c) &&
            ts.isIdentifier(c.expression) &&
            c.expression.text === "hasComponent" &&
            c.arguments.length >= 2
          ) {
            const name = readStringLiteral(c.arguments[1]);
            if (name && knownComponents.has(name)) checkedComp = name;
          }
          ts.forEachChild(c, scanCond);
        };
        const scanThen = (t: ts.Node): void => {
          if (ts.isCallExpression(t) && ts.isIdentifier(t.expression) && t.expression.text === "push") {
            const arg = t.arguments[0];
            if (arg && ts.isObjectLiteralExpression(arg)) {
              const wid = readStringLiteral(getPropertyAssignment(arg, "widgetId"));
              if (wid) pushedWidget = wid;
            }
          }
          ts.forEachChild(t, scanThen);
        };
        scanCond(n.expression);
        scanThen(n.thenStatement);
        if (checkedComp && pushedWidget) {
          edges.push({
            from: `component:${checkedComp}`,
            to: `widget:${pushedWidget}`,
            kind: "summons",
            confidence: "introspected",
            source: siteOf(relevanceRel, sf, n),
          });
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }

  if (existsSync(resolve(repoRoot, widgetsRel))) {
    trackedSet.add(widgetsRel);
  }

  if (existsSync(resolve(repoRoot, verbsRel))) {
    trackedSet.add(verbsRel);
    const sf = parseSourceFile(resolve(repoRoot, verbsRel));
    const walk = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === "CANONICAL_VERBS" &&
        n.initializer
      ) {
        let arrExpr: ts.Expression = n.initializer;
        while (ts.isAsExpression(arrExpr)) arrExpr = arrExpr.expression;
        if (ts.isArrayLiteralExpression(arrExpr)) {
          for (const el of arrExpr.elements) {
            if (!ts.isObjectLiteralExpression(el)) continue;
            const vName = readStringLiteral(getPropertyAssignment(el, "name"));
            if (!vName) continue;
            verbsCount++;
            const aliases = readStringArrayLiteral(getPropertyAssignment(el, "aliases"));
            const home = readStringLiteral(getPropertyAssignment(el, "home"));
            const signature = readStringLiteral(getPropertyAssignment(el, "signature"));
            const src = siteOf(verbsRel, sf, el);

            nodes.push({
              id: `verb:${vName}`,
              kind: "verb",
              name: vName,
              ...(aliases && aliases.length > 0 ? { aliases } : {}),
              ...(home ? { home } : {}),
              ...(signature ? { signature } : {}),
              source: src,
            });

            if (home) {
              const targets = resolveVerbHomeTargets(home, systemIds, moduleIds, knownComponents);
              for (const t of targets) {
                edges.push({
                  from: `verb:${vName}`,
                  to: t,
                  kind: "touches",
                  confidence: "introspected",
                  source: src,
                });
              }
            }
          }
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }

  if (verbsCount > 0 || widgetsCount > 0) {
    coverage.push({
      source: "apps/editor/src/authoring/**",
      status: "extracted",
      count: verbsCount + widgetsCount,
      details: `${verbsCount} canonical verbs and ${widgetsCount} authoring widgets extracted`,
    });
  }
}

function resolveVerbHomeTargets(
  home: string,
  systemIds: ReadonlySet<string>,
  moduleIds: ReadonlySet<string>,
  knownComponents: ReadonlyMap<string, IntrospectedComponent>,
): string[] {
  const targets = new Set<string>();
  const prefix = home.split("·")[0]?.trim().toLowerCase();
  const rhs = home.split("·")[1]?.trim() ?? "";
  const classMatch = rhs.match(/\b([A-Z][A-Za-z]+System|[A-Z][A-Za-z]+Service)\b/);
  if (classMatch) {
    const guessedSystem = classMatch[1]
      .replace(/System$/, "")
      .replace(/Service$/, "")
      .toLowerCase();
    // Map `ItemService` -> `system:items`, `WalletSystem` -> `system:wallet`, `CreatureSystem` -> `system:creatures`, etc.
    for (const candidate of [`${guessedSystem}s`, guessedSystem]) {
      const id = `system:${candidate}`;
      if (systemIds.has(id)) targets.add(id);
    }
  }
  if (targets.size === 0 && prefix) {
    if (systemIds.has(`system:${prefix}`)) targets.add(`system:${prefix}`);
    else if (moduleIds.has(`module:${prefix}`)) targets.add(`module:${prefix}`);
  }
  // Also link well-known components mentioned cleanly by verb semantics if present
  if (rhs.includes("Item") && knownComponents.has("WorldItem")) {
    targets.add("component:WorldItem");
  }
  return [...targets];
}

function extractProtocolRows(
  repoRoot: string,
  knownComponents: ReadonlyMap<string, IntrospectedComponent>,
  trackedSet: Set<string>,
  coverage: CoverageEntry[],
): Map<string, string[]> {
  const codecRel = "packages/protocol/src/codec.ts";
  const codecAbs = resolve(repoRoot, codecRel);
  const fieldRows = new Map<string, string[]>();
  if (!existsSync(codecAbs)) return fieldRows;

  trackedSet.add(codecRel);
  const sf = parseSourceFile(codecAbs);
  let rowCount = 0;

  for (const st of sf.statements) {
    if (!ts.isInterfaceDeclaration(st)) continue;
    const ifName = st.name.text;
    if (!ifName.endsWith("Row")) continue;
    rowCount++;
    const base = ifName.slice(0, -3);
    const compName = base === "Intent" ? "PlayerIntent" : knownComponents.has(base) ? base : undefined;
    if (!compName) continue;
    const compSchema = knownComponents.get(compName)!;
    const compFields = new Set(compSchema.fields.map((f) => f.name));
    for (const member of st.members) {
      if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name)) continue;
      const fname = member.name.text;
      if (compFields.has(fname)) {
        const key = `${compName}.${fname}`;
        const list = fieldRows.get(key) ?? [];
        list.push(ifName);
        fieldRows.set(key, list);
      }
    }
  }

  coverage.push({
    source: codecRel,
    status: "extracted",
    count: rowCount,
    details: `${rowCount} protocol wire row interfaces correlated against ECS fields`,
  });

  return fieldRows;
}
