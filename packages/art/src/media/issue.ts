/** A problem in a content document, by path (the editor shows them; a refused save writes nothing). */
export interface MediaIssue {
  path: string;
  message: string;
}

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Small checker: `add` collects issues; the helpers test one field each. */
export function checker(): {
  issues: MediaIssue[];
  add(path: string, message: string): void;
  num(o: Obj, key: string, path: string, min?: number, max?: number): void;
  str(o: Obj, key: string, path: string): void;
  hex(o: Obj, key: string, path: string): void;
} {
  const issues: MediaIssue[] = [];
  const add = (path: string, message: string): void => void issues.push({ path, message });
  return {
    issues,
    add,
    num(o, key, path, min = -Infinity, max = Infinity) {
      const v = o[key];
      if (!isNum(v)) add(`${path}${key}`, "must be a number");
      else if (v < min || v > max) add(`${path}${key}`, `must be between ${min} and ${max}`);
    },
    str(o, key, path) {
      if (typeof o[key] !== "string" || o[key] === "") add(`${path}${key}`, "must be a non-empty string");
    },
    hex(o, key, path) {
      if (typeof o[key] !== "string" || !/^#[0-9a-fA-F]{6}$/.test(o[key] as string)) add(`${path}${key}`, "must be a #rrggbb colour");
    },
  };
}
