/**
 * EA25: the player's UI has no hard-coded text. Every literal `t("id")` is in
 * the English table, the tables are valid, the pseudo-locale still formats,
 * and no JSX text or text-bearing attribute is a bare string (so a new one
 * fails here instead of slipping past the Strings panel).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { messageIssues, pseudoLocalize, t as format, validateTables } from "@mmo-engine/scene";
import { readTables } from "./i18n-setup.js";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

/** Developer tools and non-UI code: the debug overlays the editor hosts (client/debug), the dev character preview, the renderer and workers. */
const EXEMPT = [
  "ui/dev-panels.tsx",
  "ui/perf-hud.tsx",
  "ui/admin-console.tsx",
  "ui/dev-layout.ts",
  "ui/debug.ts",
  "ui/character-preview.tsx",
  "ui/admin-args.ts",
];
const SCANNED_DIRS = ["ui", "input", "audio"];

function sources(): string[] {
  const out = [join(SRC, "App.tsx")];
  for (const d of SCANNED_DIRS) {
    for (const f of readdirSync(join(SRC, d))) {
      const p = join(SRC, d, f);
      if (statSync(p).isFile() && /\.tsx?$/.test(f) && !EXEMPT.includes(`${d}/${f}`)) out.push(p);
    }
  }
  return out;
}

const TEXT_ATTRS = new Set(["title", "placeholder", "aria-label", "alt", "label"]);
const hasWords = (s: string): boolean => /[A-Za-z]{2,}/.test(s.replace(/&\w+;/g, "")) && !/^[\w+.:/-]*:\/\/[\w.:/-]*$/.test(s);

/** Whether a literal ends up on screen: a JSX child, or a text attribute, however many `?:` / `&&` it sits under. */
function displayed(n: ts.Node): boolean {
  let cur: ts.Node = n;
  while (cur.parent && (ts.isConditionalExpression(cur.parent) || ts.isParenthesizedExpression(cur.parent) || (ts.isBinaryExpression(cur.parent) && cur.parent.right === cur))) {
    if (ts.isConditionalExpression(cur.parent) && cur.parent.condition === cur) return false;
    cur = cur.parent;
  }
  const p = cur.parent;
  if (!p || !ts.isJsxExpression(p)) return false;
  const holder = p.parent;
  return ts.isJsxElement(holder) || ts.isJsxFragment(holder) || (ts.isJsxAttribute(holder) && TEXT_ATTRS.has(holder.name.getText()));
}

function scan(file: string): { bare: string[]; ids: string[] } {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const bare: string[] = [];
  const ids: string[] = [];
  const at = (n: ts.Node): string => `${relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n)) {
      const s = n.text.replace(/\s+/g, " ").trim();
      if (hasWords(s)) bare.push(`${at(n)} text "${s}"`);
    } else if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer) && TEXT_ATTRS.has(n.name.getText()) && hasWords(n.initializer.text)) {
      bare.push(`${at(n)} ${n.name.getText()}="${n.initializer.text}"`);
    } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && displayed(n) && hasWords(n.text)) {
      bare.push(`${at(n)} "${n.text}"`);
    } else if (ts.isTemplateExpression(n) && displayed(n) && hasWords([n.head.text, ...n.templateSpans.map((x) => x.literal.text)].join(" "))) {
      bare.push(`${at(n)} template ${n.getText().slice(0, 60)}`);
    } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "t" && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      ids.push(n.arguments[0].text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { bare, ids };
}

describe("string tables", () => {
  const tables = readTables();
  it("are valid and English is the source", () => {
    assert.ok(Object.keys(tables.en ?? {}).length > 100);
    assert.deepEqual(validateTables(tables), []);
  });
  it("the pseudo-locale of every message still formats the same placeholders", () => {
    for (const [id, msg] of Object.entries(tables.en)) assert.deepEqual(messageIssues(msg, pseudoLocalize(msg)), [], id);
  });
  it("every message formats without throwing", () => {
    for (const id of Object.keys(tables.en)) assert.doesNotThrow(() => format(tables.en, id, { count: 2, name: "x" }), id);
  });
});

describe("the player's UI", () => {
  const found = sources().map(scan);
  it("has no bare text or text attribute", () => {
    assert.deepEqual(found.flatMap((f) => f.bare), []);
  });
  it("only asks for ids the English table has", () => {
    const en = readTables().en;
    const missing = [...new Set(found.flatMap((f) => f.ids))].filter((id) => en[id] === undefined);
    assert.deepEqual(missing, []);
  });
});
