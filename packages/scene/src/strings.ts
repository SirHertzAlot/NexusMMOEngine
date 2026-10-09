/**
 * Localization (roadmap EA25): the string tables in
 * `content/strings/<lang>.json` and the ICU-style messages in them. Pure,
 * browser-safe: the client formats with `formatMessage` behind `t()`, the
 * editor validates tables and reports each language's status.
 *
 * Message syntax (the ICU MessageFormat subset the game uses):
 *   {name}                         an argument
 *   {n, number}                    a locale-formatted number
 *   {n, plural, =0 {..} one {..} other {.. # ..}}   plural rules of the language; # is the number
 *   {x, select, a {..} other {..}} choose by value
 *   ''  is an apostrophe, '{' quotes a brace.
 *
 * The pseudo-locale is not a file: it formats the English source with
 * every letter accented, ~30% longer, in brackets, so a string that is
 * still hard-coded (not accented) or that does not fit stands out.
 */
import type { SceneIssue } from "./index.js";

export const STRINGS_VERSION = 1;
export const PSEUDO_LANG = "pseudo";
export const SOURCE_LANG = "en";
const LANG_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const ID_RE = /^[a-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)*$/;

export interface StringsBundle {
  version: number;
  lang: string;
  messages: Record<string, string>;
  /** Translations only: the hash of the source text each message was translated from. */
  source?: Record<string, string>;
}

// ------------------------------------------------------------------ parser

interface CaseNode {
  arg: string;
  type: "plural" | "selectordinal" | "select";
  offset: number;
  cases: Record<string, Node[]>;
}
type Node = string | { arg: string; type?: "number" } | CaseNode | { pound: true };

class Parser {
  i = 0;
  constructor(readonly s: string) {}
  fail(what: string): never {
    throw new Error(`${what} at ${this.i}`);
  }
  parse(inPlural: boolean, nested: boolean): Node[] {
    const out: Node[] = [];
    let text = "";
    const flush = (): void => {
      if (text) out.push(text);
      text = "";
    };
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === "'") {
        if (s[this.i + 1] === "'") {
          text += "'";
          this.i += 2;
        } else if (s[this.i + 1] === "{" || s[this.i + 1] === "}" || (inPlural && s[this.i + 1] === "#")) {
          // quoted run, to the next lone apostrophe
          this.i++;
          for (;;) {
            if (this.i >= s.length) this.fail("unclosed quote");
            if (s[this.i] === "'") {
              if (s[this.i + 1] === "'") {
                text += "'";
                this.i += 2;
              } else {
                this.i++;
                break;
              }
            } else text += s[this.i++];
          }
        } else {
          text += c;
          this.i++;
        }
      } else if (c === "{") {
        flush();
        out.push(this.argument());
      } else if (c === "}") {
        if (!nested) this.fail("unmatched }");
        break;
      } else if (c === "#" && inPlural) {
        flush();
        out.push({ pound: true });
        this.i++;
      } else {
        text += c;
        this.i++;
      }
    }
    flush();
    return out;
  }
  ws(): void {
    while (/\s/.test(this.s[this.i] ?? "")) this.i++;
  }
  word(): string {
    const m = /^[A-Za-z0-9_=.-]+/.exec(this.s.slice(this.i));
    if (!m) this.fail("expected a name");
    this.i += m[0].length;
    return m[0];
  }
  argument(): Node {
    this.i++; // {
    this.ws();
    if (this.s[this.i] === "}") this.fail("empty argument");
    const arg = this.word();
    this.ws();
    if (this.s[this.i] === "}") {
      this.i++;
      return { arg };
    }
    if (this.s[this.i] !== ",") this.fail("expected , or }");
    this.i++;
    this.ws();
    const type = this.word();
    this.ws();
    if (type === "number") {
      if (this.s[this.i] !== "}") this.fail("expected }");
      this.i++;
      return { arg, type: "number" };
    }
    if (type !== "plural" && type !== "select" && type !== "selectordinal") this.fail(`unknown type "${type}"`);
    if (this.s[this.i] !== ",") this.fail("expected ,");
    this.i++;
    this.ws();
    let offset = 0;
    if (this.s.startsWith("offset:", this.i)) {
      this.i += 7;
      offset = Number(this.word());
      if (!Number.isFinite(offset)) this.fail("bad offset");
      this.ws();
    }
    const cases: Record<string, Node[]> = {};
    while (this.s[this.i] !== "}") {
      if (this.i >= this.s.length) this.fail("unclosed argument");
      const key = this.word();
      this.ws();
      if (this.s[this.i] !== "{") this.fail(`expected { after "${key}"`);
      this.i++;
      cases[key] = this.parse(type !== "select", true);
      if (this.s[this.i] !== "}") this.fail("unclosed case");
      this.i++;
      this.ws();
    }
    this.i++;
    if (!("other" in cases)) this.fail("missing the other case");
    return { arg, type, offset, cases };
  }
}

export function parseMessage(src: string): Node[] {
  return new Parser(src).parse(false, false);
}

/** Names of the arguments a message uses. */
export function messageArgs(src: string): Set<string> {
  const names = new Set<string>();
  const walk = (ns: Node[]): void => {
    for (const n of ns) {
      if (typeof n === "string" || "pound" in n) continue;
      names.add(n.arg);
      if ("cases" in n) for (const c of Object.values(n.cases)) walk(c);
    }
  };
  walk(parseMessage(src));
  return names;
}

// ------------------------------------------------------------------ format

const ACCENTS: Record<string, string> = {
  a: "á", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "í", j: "ĵ", k: "ķ", l: "ļ", m: "ɱ",
  n: "ñ", o: "ö", p: "þ", q: "ƣ", r: "ŕ", s: "š", t: "ţ", u: "ü", v: "ṽ", w: "ŵ", x: "ẍ", y: "ý", z: "ž",
  A: "Á", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Í", J: "Ĵ", K: "Ķ", L: "Ļ", M: "Ṁ",
  N: "Ñ", O: "Ö", P: "Þ", Q: "Ǫ", R: "Ŕ", S: "Š", T: "Ţ", U: "Ü", V: "Ṽ", W: "Ŵ", X: "Ẍ", Y: "Ý", Z: "Ž",
};
const accent = (t: string): string => t.replace(/[A-Za-z]/g, (c) => ACCENTS[c]);

export interface FormatOptions {
  lang?: string;
  pseudo?: boolean;
}

function render(ns: Node[], args: Record<string, unknown>, lang: string, pseudo: boolean, pound: string | null): string {
  let out = "";
  for (const n of ns) {
    if (typeof n === "string") out += pseudo ? accent(n) : n;
    else if ("pound" in n) out += pound ?? "#";
    else if (!(n.arg in args)) out += `{${n.arg}}`;
    else if (n.type === undefined) out += String(args[n.arg]);
    else if (n.type === "number") out += new Intl.NumberFormat(lang).format(Number(args[n.arg]));
    else {
      const c = n as CaseNode;
      if (c.type === "select") out += render(c.cases[String(args[c.arg])] ?? c.cases.other, args, lang, pseudo, pound);
      else {
        const v = Number(args[c.arg]);
        const shown = v - c.offset;
        const cat = new Intl.PluralRules(lang, { type: c.type === "plural" ? "cardinal" : "ordinal" }).select(shown);
        out += render(c.cases[`=${v}`] ?? c.cases[cat] ?? c.cases.other, args, lang, pseudo, new Intl.NumberFormat(lang).format(shown));
      }
    }
  }
  return out;
}

/** Format an ICU message. `pseudo` accents the literal text, stretches it ~30% and brackets it. */
export function formatMessage(src: string, args: Record<string, unknown> = {}, opts: FormatOptions = {}): string {
  const lang = opts.lang ?? SOURCE_LANG;
  const out = render(parseMessage(src), args, lang, opts.pseudo === true, null);
  if (!opts.pseudo) return out;
  const pad = "~".repeat(Math.ceil(out.length * 0.3));
  return `[${out}${pad}]`;
}

// ------------------------------------------------------------------ tables

/** FNV-1a, 8 hex digits: enough to notice that the source text changed. */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function validateStrings(doc: unknown, lang: string): SceneIssue[] {
  const issues: SceneIssue[] = [];
  const add = (path: string, message: string): void => void issues.push({ path, message });
  if (!LANG_RE.test(lang)) return [{ path: "lang", message: `"${lang}" is not a language code like en or pt-BR` }];
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return [{ path: "", message: "table must be an object" }];
  const d = doc as Partial<StringsBundle>;
  if (d.version !== STRINGS_VERSION) add("version", `must be ${STRINGS_VERSION}`);
  if (d.lang !== lang) add("lang", `must be "${lang}", the file's language`);
  if (typeof d.messages !== "object" || d.messages === null || Array.isArray(d.messages)) add("messages", "must be an object");
  else {
    for (const [id, m] of Object.entries(d.messages)) {
      if (!ID_RE.test(id)) add(`messages.${id}`, "id must be words joined by dots starting lowercase, like hud.bag.title");
      else if (typeof m !== "string") add(`messages.${id}`, "must be a string");
      else
        try {
          parseMessage(m);
        } catch (e) {
          add(`messages.${id}`, e instanceof Error ? e.message : String(e));
        }
    }
  }
  if (d.source !== undefined) {
    if (typeof d.source !== "object" || d.source === null || Array.isArray(d.source)) add("source", "must be an object");
    else for (const [id, h] of Object.entries(d.source)) if (typeof h !== "string") add(`source.${id}`, "must be a string");
  }
  return issues;
}

export type StringStatus = "ok" | "missing" | "stale" | "mismatch" | "long";
export interface StringsStatus {
  rows: Array<{ id: string; status: StringStatus }>;
  /** Ids the translation has that the source does not. */
  extra: string[];
  counts: Record<StringStatus, number>;
}

const sameSet = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

/** How a translation stands against the source: in the order of the source's ids. */
export function stringsStatus(source: StringsBundle, tr: StringsBundle): StringsStatus {
  const counts: Record<StringStatus, number> = { ok: 0, missing: 0, stale: 0, mismatch: 0, long: 0 };
  const rows = Object.keys(source.messages).map((id) => {
    const src = source.messages[id];
    const text = tr.messages[id];
    let status: StringStatus = "ok";
    if (text === undefined) status = "missing";
    else {
      let argsDiffer = false;
      try {
        argsDiffer = !sameSet(messageArgs(src), messageArgs(text));
      } catch {
        argsDiffer = true;
      }
      const h = tr.source?.[id];
      if (argsDiffer) status = "mismatch";
      else if (h !== undefined && h !== textHash(src)) status = "stale";
      else if (text.length > Math.max(20, src.length * 1.5)) status = "long";
    }
    counts[status]++;
    return { id, status };
  });
  return { rows, extra: Object.keys(tr.messages).filter((id) => !(id in source.messages)), counts };
}
