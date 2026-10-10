/**
 * Localization string tables (roadmap EA25).
 *
 * `content/strings/<lang>.json` maps string ids to ICU messages; English
 * (`en`) is the source. Pure and browser-safe so the client, the editor's
 * Strings panel and its dev host all share one implementation (engine-core
 * re-exports `t`, `loadStrings` and `pseudoLocalize` from here).
 *
 * The ICU subset: `{name}`, `{n, plural, one {# x} other {# xs}}` (also
 * `=0 {..}`) and `{k, select, a {..} other {..}}`; branches may hold more
 * placeholders. There is no apostrophe quoting: `{` and `}` are always
 * syntax, so a literal brace cannot appear in a message.
 *
 * The pseudo-locale is not a file: it is the English source accented and
 * stretched, so any text that is not in a table shows up unaccented and
 * any layout that cannot take longer text overflows.
 */

export const SOURCE_LANG = "en";
export const PSEUDO_LANG = "pseudo";

export type Strings = Record<string, string>;
export type Values = Record<string, string | number>;

/** One table per language code. */
export type StringTables = Record<string, Strings>;

// --- ICU subset ---------------------------------------------------------

type Node =
  | { t: "text"; text: string }
  | { t: "hash" }
  | { t: "arg"; name: string }
  | { t: "choice"; name: string; kind: "plural" | "select"; options: Array<[string, Node[]]> };

class IcuError extends Error {}

function parseIcu(src: string): Node[] {
  let i = 0;
  const fail = (what: string): never => {
    throw new IcuError(`${what} at ${i}`);
  };
  const branch = (inPlural: boolean, nested: boolean): Node[] => {
    const out: Node[] = [];
    let text = "";
    const flush = (): void => {
      if (text) out.push({ t: "text", text });
      text = "";
    };
    while (i < src.length) {
      const c = src[i];
      if (c === "}") {
        if (!nested) fail("unmatched }");
        flush();
        return out;
      }
      if (c === "{") {
        flush();
        i++;
        out.push(argument(inPlural));
      } else if (c === "#" && inPlural) {
        flush();
        out.push({ t: "hash" });
        i++;
      } else {
        text += c;
        i++;
      }
    }
    if (nested) fail("missing }");
    flush();
    return out;
  };
  const argument = (inPlural: boolean): Node => {
    const start = i;
    while (i < src.length && src[i] !== "," && src[i] !== "}") i++;
    if (i >= src.length) fail("missing }");
    const name = src.slice(start, i).trim();
    if (!/^\w+$/.test(name)) fail(`bad placeholder name "${name}"`);
    if (src[i] === "}") {
      i++;
      return { t: "arg", name };
    }
    i++; // ,
    const ks = i;
    while (i < src.length && src[i] !== ",") i++;
    const kind = src.slice(ks, i).trim();
    if (kind !== "plural" && kind !== "select") fail(`unsupported type "${kind}"`);
    i++; // ,
    const options: Array<[string, Node[]]> = [];
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (i >= src.length) fail("missing }");
      if (src[i] === "}") {
        i++;
        break;
      }
      const k0 = i;
      while (i < src.length && !/[\s{}]/.test(src[i])) i++;
      const key = src.slice(k0, i);
      while (i < src.length && /\s/.test(src[i])) i++;
      if (!key || src[i] !== "{") fail("expected { after option");
      i++;
      options.push([key, branch(kind === "plural" || inPlural, true)]);
      i++; // the branch's closing }
    }
    if (!options.some(([k]) => k === "other")) fail(`${kind} needs an "other" option`);
    return { t: "choice", name, kind: kind as "plural" | "select", options };
  };
  return branch(false, false);
}

function formatNodes(nodes: Node[], values: Values, hash: string): string {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += n.text;
    else if (n.t === "hash") out += hash;
    else if (n.t === "arg") out += values[n.name] === undefined ? `{${n.name}}` : String(values[n.name]);
    else if (n.kind === "plural") {
      const count = Number(values[n.name] ?? 0);
      const pick = n.options.find(([k]) => k === `=${count}`) ?? n.options.find(([k]) => k === (count === 1 ? "one" : "other")) ?? n.options.find(([k]) => k === "other");
      out += formatNodes(pick![1], values, String(count));
    } else {
      const v = String(values[n.name] ?? "");
      const pick = n.options.find(([k]) => k === v) ?? n.options.find(([k]) => k === "other");
      out += formatNodes(pick![1], values, hash);
    }
  }
  return out;
}

/** The message back as ICU source, with `onText` applied to every literal run. */
function renderNodes(nodes: Node[], onText: (s: string) => string): string {
  return nodes
    .map((n) => {
      if (n.t === "text") return onText(n.text);
      if (n.t === "hash") return "#";
      if (n.t === "arg") return `{${n.name}}`;
      return `{${n.name}, ${n.kind}, ${n.options.map(([k, b]) => `${k} {${renderNodes(b, onText)}}`).join(" ")}}`;
    })
    .join("");
}

function placeholders(nodes: Node[], into = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.t === "arg") into.add(n.name);
    else if (n.t === "choice") {
      into.add(n.name);
      for (const [, b] of n.options) placeholders(b, into);
    }
  }
  return into;
}

// --- Public API ---------------------------------------------------------

/** "de", "pt-BR": a language that has a table file (the pseudo-locale has none). */
export function isLangCode(lang: string): boolean {
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(lang) && lang !== PSEUDO_LANG;
}

function isStringId(id: string): boolean {
  return /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(id);
}

/** Parse and validate one string table (throws on invalid). */
export function loadStrings(json: unknown): Strings {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("string table: expected an object of string ids to text");
  const out: Strings = {};
  for (const [id, v] of Object.entries(json)) {
    if (id === "") throw new Error("string table: empty string id");
    if (typeof v !== "string") throw new Error(`string table: "${id}" must be a string, not ${typeof v}`);
    out[id] = v;
  }
  return out;
}

/** Format a message by id; falls back to the id when missing (and to the raw text when the message is malformed). */
export function t(table: Strings, id: string, values: Values = {}): string {
  const msg = table[id];
  if (msg === undefined) return id;
  try {
    return formatNodes(parseIcu(msg), values, "");
  } catch {
    return msg;
  }
}

/**
 * Pseudo-locale: accents every letter of the literal text, stretches it by
 * about a third and wraps it in ⟦ ⟧ so a clipped end shows. Placeholders
 * and plural syntax pass through, so the result still formats.
 */
export function pseudoLocalize(msg: string): string {
  const ACCENT = "́"; // combining acute
  let nodes: Node[];
  try {
    nodes = parseIcu(msg);
  } catch {
    return `⟦${msg}⟧`;
  }
  let letters = 0;
  const body = renderNodes(nodes, (s) =>
    s.replace(/[a-zA-Z]/g, (c) => {
      letters++;
      return c + ACCENT;
    }),
  );
  return `⟦${body}${"~".repeat(Math.ceil(letters / 3))}⟧`;
}

/** Why `msg` is not a valid translation of `source`; empty when it is fine. */
export function messageIssues(source: string | undefined, msg: string): string[] {
  const issues: string[] = [];
  if (msg.trim() === "") return ["empty"];
  let nodes: Node[];
  try {
    nodes = parseIcu(msg);
  } catch (e) {
    return [`not valid ICU: ${e instanceof IcuError ? e.message : String(e)}`];
  }
  if (source === undefined) return issues;
  let srcNodes: Node[];
  try {
    srcNodes = parseIcu(source);
  } catch {
    return issues; // the source's own problem is reported on the source
  }
  const want = placeholders(srcNodes);
  const have = placeholders(nodes);
  for (const p of want) if (!have.has(p)) issues.push(`missing placeholder {${p}}`);
  for (const p of have) if (!want.has(p)) issues.push(`unknown placeholder {${p}}`);
  return issues;
}

/** The language to use: `?lang=` beats the stored choice, which beats the browser's; unknown codes fall to English. */
export function pickLang(available: readonly string[], search: string, stored: string | null, browser: readonly string[]): string {
  const ok = (l: string | null | undefined): boolean => !!l && (l === PSEUDO_LANG || available.includes(l));
  const q = new URLSearchParams(search).get("lang");
  if (q && ok(q)) return q;
  if (stored && ok(stored)) return stored;
  for (const b of browser) {
    if (ok(b)) return b;
    const base = b.split("-")[0];
    if (ok(base)) return base;
  }
  return SOURCE_LANG;
}

export type Translate = (id: string, values?: Values) => string;

/**
 * `t` for one language over all the tables. A message missing in `lang`
 * falls back to English, then to its id, so a gap shows as text, never as
 * a blank. `pseudo` is the English source run through `pseudoLocalize`.
 */
export function translator(tables: StringTables, lang: string): Translate {
  const en = tables[SOURCE_LANG] ?? {};
  const own = lang === PSEUDO_LANG ? {} : (tables[lang] ?? {});
  return (id, values = {}) => {
    if (lang === PSEUDO_LANG) return en[id] === undefined ? id : t({ [id]: pseudoLocalize(en[id]) }, id, values);
    return t(own[id] !== undefined ? own : en, id, values);
  };
}

// --- Whole-set checks and the panel's report --------------------------------

export interface StringIssue {
  lang: string;
  id: string;
  message: string;
}

/** Every problem of a set of tables: ids that are not ids, bad ICU, placeholders that differ from English, ids English lacks. */
export function validateTables(tables: StringTables): StringIssue[] {
  const issues: StringIssue[] = [];
  const en = tables[SOURCE_LANG] ?? {};
  for (const [lang, table] of Object.entries(tables)) {
    for (const [id, msg] of Object.entries(table)) {
      const add = (message: string): void => void issues.push({ lang, id, message });
      if (!isStringId(id)) add("not a string id (letters, digits, _ and -, joined by dots)");
      if (lang !== SOURCE_LANG && en[id] === undefined) add("not in the English source");
      for (const m of messageIssues(lang === SOURCE_LANG ? undefined : en[id], msg)) add(m);
    }
  }
  return issues;
}

export type CellStatus = "ok" | "missing" | "invalid" | "extra";

export interface StringRow {
  id: string;
  /** Per language: its text (undefined when missing) and status. English reads "ok" when present. */
  cells: Record<string, { text?: string; status: CellStatus; issues: string[] }>;
}

/** Every id of every table with each language's status, English ids first in file order. */
export function stringRows(tables: StringTables, langs: readonly string[]): StringRow[] {
  const en = tables[SOURCE_LANG] ?? {};
  const ids = [...Object.keys(en)];
  for (const l of langs) for (const id of Object.keys(tables[l] ?? {})) if (!ids.includes(id)) ids.push(id);
  return ids.map((id) => {
    const cells: StringRow["cells"] = {};
    for (const l of langs) {
      const text = (tables[l] ?? {})[id];
      if (text === undefined) cells[l] = { status: "missing", issues: [] };
      else if (l !== SOURCE_LANG && en[id] === undefined) cells[l] = { text, status: "extra", issues: ["not in the English source"] };
      else {
        const issues = messageIssues(l === SOURCE_LANG ? undefined : en[id], text);
        cells[l] = { text, status: issues.length ? "invalid" : "ok", issues };
      }
    }
    return { id, cells };
  });
}
