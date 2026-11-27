/**
 * Game panel (roadmap EB10, Modules › Game): the game's `game.json` —
 * its name, and the settings each module reads from it.
 *
 * `#749` put per-module settings in the manifest and nothing edits them;
 * this does. A module declares what it reads (`settings` in its
 * `module.json`) and gets a labelled field per declaration; a key the
 * manifest sets that nobody declared is still shown and still editable,
 * because the engine fixes no key list and a game's own module may read
 * whatever it likes.
 *
 * Creating the manifest is a button, never a side effect of opening the
 * panel: a `game.json` turns a checkout into a game project and changes
 * how every path resolves at boot. The host refuses to write over one
 * that is already there.
 */

import * as React from "react";
import {
  createGame,
  loadGame,
  saveGame,
  settingsOf,
  withSetting,
  type GameState,
  type ModuleSettingsInfo,
  type SettingInfo,
} from "../game-client.js";
import type { RulesIssue } from "../rules-control.js";
import { Badge, Button, Card, CardContent, CardTitle, Input, Label, SectionTitle, Select } from "./components.js";
import { IssueList } from "./spec-form.js";
import { useSaveTask } from "./use-save-task.js";

/** The text in the box for a setting: what the game set, else blank (the module's default shows as the placeholder). */
export function settingText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * What a typed field's text means, or why it cannot be used. An empty
 * box is `undefined`: the key goes away and the module's own default
 * applies again.
 */
export function parseSetting(spec: SettingInfo, text: string): { value: unknown } | { error: string } {
  const t = text.trim();
  if (t === "") return { value: undefined };
  switch (spec.type) {
    case "number": {
      const n = Number(t);
      if (!Number.isFinite(n)) return { error: "must be a number" };
      if (spec.int && !Number.isInteger(n)) return { error: "must be a whole number" };
      if (spec.min !== undefined && n < spec.min) return { error: `must be ${spec.min} or more` };
      if (spec.max !== undefined && n > spec.max) return { error: `must be ${spec.max} or less` };
      return { value: n };
    }
    case "boolean":
      if (t === "true") return { value: true };
      if (t === "false") return { value: false };
      return { error: "must be true or false" };
    case "enum":
      return spec.options?.includes(t) ? { value: t } : { error: `must be one of ${spec.options?.join(", ") ?? ""}` };
    default:
      return { value: t };
  }
}

/** A module's line in the list: how many of its settings this game sets. */
export function moduleSummary(row: ModuleSettingsInfo, set: Record<string, unknown>): string {
  const declared = row.settings.length;
  const chosen = Object.keys(set).length;
  if (declared === 0 && chosen === 0) return "Declares no settings.";
  const parts: string[] = [];
  if (declared > 0) parts.push(`${declared} setting${declared === 1 ? "" : "s"}`);
  parts.push(chosen === 0 ? "none set by this game" : `${chosen} set here`);
  return `${parts.join(", ")}.`;
}

function SettingField(props: {
  spec: SettingInfo;
  value: unknown;
  onChange(value: unknown): void;
}): React.JSX.Element {
  const [text, setText] = React.useState(settingText(props.value));
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => setText(settingText(props.value)), [props.value]);
  const commit = (next: string): void => {
    setText(next);
    const r = parseSetting(props.spec, next);
    if ("error" in r) setError(r.error);
    else {
      setError(null);
      props.onChange(r.value);
    }
  };
  const placeholder = props.spec.default === undefined ? "the module's own default" : String(props.spec.default);
  const choices = props.spec.type === "boolean" ? ["", "true", "false"] : props.spec.type === "enum" ? ["", ...(props.spec.options ?? [])] : null;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`setting-${props.spec.key}`}>{props.spec.label ?? props.spec.key}</Label>
      {choices ? (
        <Select id={`setting-${props.spec.key}`} size="md" value={text} onChange={(e) => commit(e.target.value)}>
          {choices.map((c) => (
            <option key={c} value={c}>
              {c === "" ? placeholder : c}
            </option>
          ))}
        </Select>
      ) : (
        <Input id={`setting-${props.spec.key}`} value={text} placeholder={placeholder} onChange={(e) => commit(e.target.value)} />
      )}
      {props.spec.help && (
        <span className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
          {props.spec.help}
        </span>
      )}
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}

function ModuleCard(props: {
  row: ModuleSettingsInfo;
  manifest: Record<string, unknown>;
  onChange(next: Record<string, unknown>): void;
}): React.JSX.Element {
  const set = settingsOf(props.manifest, props.row.module);
  const put = (key: string, value: unknown): void => props.onChange(withSetting(props.manifest, props.row.module, key, value));
  return (
    <Card data-testid={`game-module-${props.row.module}`}>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-baseline gap-2">
          <CardTitle>{props.row.module}</CardTitle>
          {!props.row.enabled && <Badge tone="info">off</Badge>}
          <span className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
            {moduleSummary(props.row, set)}
          </span>
        </div>
        {props.row.settings.length > 0 && (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {props.row.settings.map((s) => (
              <SettingField key={s.key} spec={s} value={set[s.key]} onChange={(v) => put(s.key, v)} />
            ))}
          </div>
        )}
        {props.row.undeclared.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
              Set by this game, not declared by the module — which is allowed: a module reads whatever keys it likes.
            </span>
            {props.row.undeclared.map((key) => (
              <div key={key} className="flex items-center gap-2">
                <Label className="w-40 shrink-0" htmlFor={`free-${props.row.module}-${key}`}>
                  {key}
                </Label>
                <Input
                  id={`free-${props.row.module}-${key}`}
                  value={settingText(set[key])}
                  onChange={(e) => {
                    const t = e.target.value;
                    if (t.trim() === "") return put(key, undefined);
                    try {
                      return put(key, JSON.parse(t) as unknown);
                    } catch {
                      return put(key, t);
                    }
                  }}
                />
                <Button size="sm" variant="outline" onClick={() => put(key, undefined)} aria-label={`Remove ${key}`}>
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function GamePanel(): React.JSX.Element {
  const [state, setState] = React.useState<GameState | null>(null);
  const [draft, setDraft] = React.useState<Record<string, unknown> | null>(null);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const task = useSaveTask<RulesIssue>();

  const load = React.useCallback(async () => {
    setLoadError(null);
    try {
      const next = await loadGame();
      setState(next);
      setDraft(next.manifest);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);

  if (loadError) return <p className="p-4 text-sm text-red-400">{loadError}</p>;
  if (!state) return <p className="p-4 text-sm text-muted-foreground">Reading the game manifest…</p>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(state.manifest);
  // A card each for the modules there is something to say about; the rest
  // are one line, because 35 cards reading "declares no settings" is a
  // worse answer than a sentence.
  const says = (row: ModuleSettingsInfo): boolean =>
    row.settings.length > 0 || row.undeclared.length > 0 || Object.keys(settingsOf(draft, row.module)).length > 0;
  const configurable = state.modules.filter(says);
  const quiet = state.modules.filter((m) => !says(m)).map((m) => m.module);

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-4" data-testid="game-panel">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle>Game manifest</SectionTitle>
        <code className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
          {state.file}
        </code>
        <span className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" disabled={!dirty} onClick={() => setDraft(state.manifest)}>
            Revert
          </Button>
          <Button
            size="sm"
            disabled={!dirty || draft === null || task.busy}
            data-testid="game-save"
            onClick={() =>
              void task.run(
                async () => {
                  const next = await saveGame(draft!);
                  setState(next);
                  setDraft(next.manifest);
                },
                { ok: "Saved game.json — restart play mode to apply it" },
              )
            }
          >
            Save
          </Button>
        </span>
      </div>

      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
      <IssueList issues={task.issues} />
      {task.status && (
        <p className="text-sm" style={{ color: task.status.tone === "ok" ? "var(--m3-on-surface-variant)" : "var(--m3-error)" }} data-testid="game-status">
          {task.status.text}
        </p>
      )}

      {!state.exists ? (
        <Card data-testid="game-none">
          <CardContent className="flex flex-col gap-3 p-4">
            <CardTitle>This project has no game.json</CardTitle>
            <p className="text-sm">
              Every path falls back to the engine&apos;s own default, which is how the engine checkout itself runs. A manifest says where this game&apos;s content lives and
              carries the settings its modules read — writing one makes this a game project, so it is a button rather than something that happens when you open this panel.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="game-name">Name</Label>
                <Input id="game-name" value={name} placeholder="My game" onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor="game-description">Description</Label>
                <Input id="game-description" value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
              <Button
                disabled={name.trim().length === 0 || task.busy}
                data-testid="game-create"
                onClick={() =>
                  void task.run(
                    async () => {
                      const next = await createGame(name.trim(), description);
                      setState(next);
                      setDraft(next.manifest);
                      return next;
                    },
                    { ok: (next: GameState) => `Wrote ${next.file}` },
                  )
                }
              >
                Create game.json
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
            The server reads this at start: restart play mode to apply a saved change. An empty box means the module&apos;s own default, and an `MMO_*` variable set for a run
            still wins over both.
          </p>
          {configurable.map((row) => (
            <ModuleCard key={row.module} row={row} manifest={draft ?? {}} onChange={setDraft} />
          ))}
          {configurable.length === 0 && (
            <p className="text-sm" style={{ color: "var(--m3-on-surface-variant)" }} data-testid="game-no-settings">
              No module declares a setting yet, and this game sets none. A module declares what it reads in its own <code>module.json</code>.
            </p>
          )}
          {quiet.length > 0 && (
            <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }} data-testid="game-quiet-modules">
              {quiet.length} other module{quiet.length === 1 ? "" : "s"} declare no settings and are set by nothing here: {quiet.join(", ")}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
