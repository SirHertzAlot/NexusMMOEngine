/**
 * Action inputs — the designer-supplied values a widget/shelf action
 * needs before its verb call can honestly dispatch.
 *
 * The dispatch mapper (dispatch.ts) is the single gate: it refuses a
 * call whose params are placeholders (an empty def, amount 0, an empty
 * vendor template). This module describes, AS DATA, the minimal field
 * each action must collect so a filled-in call passes that gate:
 *
 *   - a descriptor per field (id, label, kind, and — for pickers — the
 *     SOURCE the view resolves to a real option list),
 *   - the raw values record the view keeps (strings, as the DOM gives),
 *   - the small pure helpers that turn values into params.
 *
 * No validation lives here beyond parsing: an empty or unparseable
 * value contributes the action's placeholder param (or nothing), the
 * built call goes to the mapper, and the mapper's refusal is the
 * answer the designer sees. Nothing here pre-approves a call.
 *
 * Picker sources (resolved by the view, never hardcoded here):
 *   - "item-bases"      — item base names from the gameplay snapshot
 *                         (content/rules/items.json `bases`, via the
 *                         editor's gameplay-host refs). Available from
 *                         the dev host even when no play server runs;
 *                         the give itself still needs the server.
 *   - "creature-kinds"  — creature kind names from the same snapshot
 *                         (content/rules/creatures.json `creatures`) —
 *                         the registry the server's spawn command checks.
 *   - "vendor-templates"— template ids DEFINED on the running server,
 *                         read with admin `vendor {sub:"list"}` (the
 *                         server defines content/vendors.json templates
 *                         lazily, when a scene names one or an admin
 *                         defines one — so the live list is the only
 *                         honest source). Offline there is no list.
 */

export type ActionInputKind = "picker" | "number" | "text";

export type PickerSource = "item-bases" | "creature-kinds" | "vendor-templates";

export interface ActionInput {
  /** Value key: the entry in the values record, and (unless a spec's param builder says otherwise) the param it feeds. */
  id: string;
  /** Designer-language label rendered beside the field. */
  label: string;
  kind: ActionInputKind;
  /** For pickers: which real list the view fills the options from. */
  source?: PickerSource;
  /** Prefill baked by the builder (e.g. teleport x/z from the selection's Transform position; a vendor's current template). Rendered as the field's starting value; the designer can edit it before dispatch. */
  initial?: string;
  /** Grey hint text for empty fields. */
  placeholder?: string;
}

/** Raw field values, keyed by input id — strings, exactly as the DOM holds them. */
export type InputValues = Readonly<Record<string, string>>;

/** The effective value of one input: what the designer typed, else the descriptor's prefill, else empty. */
export function inputValue(values: InputValues, input: ActionInput): string {
  const v = values[input.id];
  return v !== undefined ? v : (input.initial ?? "");
}

/**
 * Parse a number field. Empty or non-numeric → undefined, and the
 * param builder falls back to its placeholder so the mapper — not
 * this parser — delivers the refusal.
 */
export function parseInputNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse the admin `vendor {sub:"list"}` answer into template ids.
 * The gateway's format (net/gateway.ts): `vendors: a, b, c`, or
 * `no vendors defined` when the server has none. Anything else
 * (including a refusal message) parses to an empty list — the picker
 * then honestly shows "none defined".
 */
export function parseVendorTemplateList(message: string): readonly string[] {
  const m = message.match(/^vendors:\s*(.+)$/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}
