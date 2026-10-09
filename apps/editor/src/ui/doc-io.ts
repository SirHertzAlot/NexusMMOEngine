/**
 * Import / export of the open document as a .json file (File menu).
 *
 * Export downloads the document exactly as the panel would save it.
 * Import reads a chosen file, refuses anything that is not JSON or that
 * does not have the shape of the open document, and only then hands it to
 * the panel's importDoc (which runs the panel's own validation). Nothing
 * is written to disk by an import: it fills the draft, and Save goes
 * through the host's validated save like any other edit.
 */

import type { DocActions } from "./doc-actions.js";

export function parseJsonText(text: string, fileName = "file"): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(`${fileName}: not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
}

const kind = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** Null when `incoming` has the shape of `current` (same kind; objects keep every top-level key), else the reason. */
export function checkImportShape(current: unknown, incoming: unknown): string | null {
  if (kind(current) !== kind(incoming)) return `expected ${kind(current)} but the file holds ${kind(incoming)}`;
  if (kind(current) === "object") {
    const have = incoming as Record<string, unknown>;
    const missing = Object.keys(current as Record<string, unknown>).filter((k) => !(k in have));
    if (missing.length > 0) return `missing ${missing.length === 1 ? "key" : "keys"} ${missing.map((k) => `"${k}"`).join(", ")}`;
  }
  return null;
}

/** Validate then apply an imported file's text to the document; throws a readable Error when refused. */
export async function applyImportText(doc: DocActions, text: string, fileName = "file"): Promise<void> {
  if (!doc.importDoc || !doc.exportDoc) throw new Error(`${doc.label} cannot be imported`);
  const incoming = parseJsonText(text, fileName);
  const why = checkImportShape(doc.exportDoc().data, incoming);
  if (why !== null) throw new Error(`${fileName} is not a ${doc.label} document: ${why}`);
  await doc.importDoc(incoming);
}

export function exportFileName(name: string): string {
  return `${name.replace(/[^\w.-]+/g, "-")}.json`;
}

export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportDocument(doc: DocActions): string {
  if (!doc.exportDoc) throw new Error(`${doc.label} cannot be exported`);
  const { name, data } = doc.exportDoc();
  const fileName = exportFileName(name);
  downloadBlob(fileName, new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" }));
  return fileName;
}

/** Ask for a .json file and import it into the document; resolves to the file name, or null if the picker was dismissed. */
export function importDocument(doc: DocActions): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      file
        .text()
        .then((text) => applyImportText(doc, text, file.name))
        .then(() => resolve(file.name), reject);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
