/**
 * The character screen, between login and the world: the account's
 * characters (pick one, enter the world) and character creation — a 3D
 * preview (orbit, zoom, head/body framing), a picker per part category,
 * colour swatches, gender, randomise, and a name. A new character wears
 * the starter armour; everything else about its appearance is chosen
 * here. Creating a character enters the world as it.
 *
 * Server calls come in as props, so the dev preview (?preview=character)
 * runs the same screen with no server.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { CHARACTER_NAME_RE, type CharacterEntry } from "@mmo-engine/protocol";
import {
  HAIR_COLOURS,
  SKIN_TONES,
  parseLook,
  partsFor,
  randomLook,
  type CatalogPart,
  type CharacterLook,
  type ColourSlot,
  type Gender,
  type ModularCatalog,
  type Slot,
} from "@mmo-engine/art/browser";
import { CharacterStage } from "../render/character/character-stage.js";
import { Button, Input, Label } from "./components.js";
import { t } from "../i18n.js";

export interface CharacterScreenProps {
  characters: CharacterEntry[];
  maxCharacters: number;
  /** Create the character and enter the world as it; rejects with the server's reason. */
  onCreate(name: string, look: CharacterLook): Promise<void>;
  /** Enter the world as a character; rejects with the server's reason. */
  onEnter(id: number): Promise<void>;
  /** Back to the login screen. */
  onLeave(): void;
  /** Dev preview: a clip to play on the character (repeating). */
  previewClip?: string | null;
  /** Dev preview: also load the raw reference takes (long mocap). */
  referenceClips?: boolean;
  /** Which half to open on (the flow's node); default: the list when there are characters. */
  initialMode?: "list" | "create";
  /** The flow hears about the switch: "create" is ui.create, "list" is ui.select. */
  onModeChange?: (mode: "list" | "create") => void;
}

interface Category {
  slot: Slot;
  /** May be left empty. */
  optional: boolean;
  /** Offered to this gender only. */
  gender?: Gender;
}

// Eyes, nose and mouth come with the face (the pack's heads).
const CATEGORIES: Category[] = [
  { slot: "head", optional: false },
  { slot: "hair", optional: true },
  { slot: "eyebrows", optional: true },
  { slot: "facialHair", optional: true, gender: "male" },
  { slot: "ears", optional: true },
];

interface ColourRow {
  slot: ColourSlot;
  swatches: readonly string[];
  /** May be left unset (the region follows the skin). */
  optional: boolean;
  gender?: Gender;
}

const BODY_ART = ["#2b4c8c", "#4566a9", "#6b2f8f", "#8c2b2b", "#2f6b3a", "#1c1c1c", "#c8a24a", "#e8e8e8"] as const;
const SCARS = ["#e6b8a2", "#c98f7a", "#a86d5c", "#7a4a3c"] as const;

const COLOUR_ROWS: ColourRow[] = [
  { slot: "skin", swatches: SKIN_TONES, optional: false },
  { slot: "hair", swatches: HAIR_COLOURS, optional: false },
  { slot: "stubble", swatches: HAIR_COLOURS, optional: true, gender: "male" },
  { slot: "scar", swatches: SCARS, optional: true },
  { slot: "bodyArt", swatches: BODY_ART, optional: true },
];

/** The options a category offers (mask heads are for helmets, not faces). */
function optionsFor(catalog: ModularCatalog, c: Category, gender: Gender): CatalogPart[] {
  return partsFor(catalog, c.slot, gender).filter((p) => !p.mask);
}

/** A starting look for `gender`: the first face, first eyebrows, and the gender's usual colours. */
function startingLook(catalog: ModularCatalog | null, gender: Gender): CharacterLook {
  const first = (slot: Slot): string | undefined =>
    catalog ? optionsFor(catalog, { slot, optional: false }, gender)[0]?.name : undefined;
  return {
    gender,
    parts: { head: first("head"), hair: first("hair"), eyebrows: first("eyebrows") },
    colours: { skin: SKIN_TONES[2], hair: HAIR_COLOURS[2] },
  };
}

/**
 * The part `d` steps from `value` in `options`, wrapping; optional
 * categories pass through "none" (null) between the last and the first.
 */
function stepPart(options: CatalogPart[], value: string | null | undefined, optional: boolean, d: number): string | null {
  const min = optional ? -1 : 0;
  const count = options.length - min;
  if (count <= 0) return null;
  const at = options.findIndex((p) => p.name === value);
  const pos = ((((at < min ? min : at) - min + d) % count) + count) % count + min;
  return pos < 0 ? null : options[pos].name;
}

function Picker({
  label,
  options,
  value,
  onStep,
}: {
  label: string;
  options: CatalogPart[];
  value: string | null | undefined;
  onStep(d: number): void;
}): React.ReactElement {
  const at = options.findIndex((p) => p.name === value);
  const step = onStep;
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="w-24 text-sm text-muted-foreground">{label}</span>
      <Button size="sm" variant="secondary" aria-label={t("character.previous", { part: label })} onClick={() => step(-1)}>
        ‹
      </Button>
      <span className="w-16 text-center text-sm tabular-nums">
        {at < 0 ? t("character.none") : t("character.position", { at: at + 1, count: options.length })}
      </span>
      <Button size="sm" variant="secondary" aria-label={t("character.next", { part: label })} onClick={() => step(1)}>
        ›
      </Button>
    </div>
  );
}

function Swatches({
  row,
  value,
  onChange,
}: {
  row: ColourRow;
  value: string | undefined;
  onChange(colour: string | undefined): void;
}): React.ReactElement {
  const label = t(`character.colour.${row.slot}`);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <input
          type="color"
          aria-label={t("character.colourOf", { part: label })}
          className="h-5 w-8 cursor-pointer rounded border border-input bg-transparent"
          value={value ?? "#000000"}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-1">
        {row.optional && (
          <button
            title={t("character.none")}
            aria-label={t("character.noColour", { part: label })}
            className={`h-5 w-5 rounded-sm border text-[10px] leading-none text-muted-foreground ${value === undefined ? "border-foreground" : "border-input"}`}
            onClick={() => onChange(undefined)}
          >
            ∅
          </button>
        )}
        {row.swatches.map((c) => (
          <button
            key={c}
            title={c}
            aria-label={t("character.colourValue", { part: label, colour: c })}
            className={`h-5 w-5 rounded-sm border ${value?.toLowerCase() === c ? "border-foreground ring-1 ring-foreground" : "border-black/40"}`}
            style={{ background: c }}
            onClick={() => onChange(c)}
          />
        ))}
      </div>
    </div>
  );
}

export function CharacterScreen(props: CharacterScreenProps): React.ReactElement {
  const { characters, maxCharacters } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [stage, setStage] = useState<CharacterStage | null>(null);
  const [artError, setArtError] = useState<string | null>(null);
  const [mode, setModeState] = useState<"list" | "create">(props.initialMode ?? (characters.length > 0 ? "list" : "create"));
  const setMode = (m: "list" | "create"): void => {
    setModeState(m);
    props.onModeChange?.(m);
  };
  const [selected, setSelected] = useState<number | null>(characters[0]?.id ?? null);
  const [look, setLook] = useState<CharacterLook>(() => startingLook(null, "male"));
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [framing, setFraming] = useState<"body" | "head">("body");
  const catalog = stage?.kit.catalog ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let made: CharacterStage | null = null;
    let cancelled = false;
    CharacterStage.create(canvas, undefined, { referenceClips: props.referenceClips })
      .then((s) => {
        if (cancelled) return s.dispose();
        made = s;
        setStage(s);
        setLook(startingLook(s.kit.catalog, "male"));
      })
      .catch((e: unknown) => setArtError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      made?.dispose();
    };
  }, []);

  const shown = useMemo<CharacterLook | null>(() => {
    if (mode === "create") return look;
    const c = characters.find((x) => x.id === selected);
    return c ? parseLook(c.look) : null;
  }, [mode, look, selected, characters]);

  useEffect(() => {
    if (!stage || !shown) return;
    stage.show(shown).catch((e: unknown) => setArtError(e instanceof Error ? e.message : String(e)));
  }, [stage, shown]);

  useEffect(() => stage?.focus(framing), [stage, framing]);

  useEffect(() => {
    if (stage && props.previewClip !== undefined) stage.playClip(props.previewClip);
  }, [stage, props.previewClip]);

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^hello rejected: \d+ /, ""));
    } finally {
      setBusy(false);
    }
  };

  // Updates build on the latest look (several clicks can land between renders).
  const setGender = (gender: Gender): void =>
    setLook((l) => {
      if (gender === l.gender) return l;
      // Parts are per gender; keep the colours (stubble is men's only).
      const { stubble: _stubble, ...colours } = l.colours;
      return { ...startingLook(catalog, gender), colours: gender === "male" ? l.colours : colours };
    });
  const stepCategory = (c: Category, d: number): void =>
    setLook((l) => {
      if (!catalog) return l;
      const part = stepPart(optionsFor(catalog, c, l.gender), l.parts[c.slot], c.optional, d);
      return { ...l, parts: { ...l.parts, [c.slot]: part ?? undefined } };
    });
  const setColour = (slot: ColourSlot, colour: string | undefined): void =>
    setLook((l) => {
      const colours = { ...l.colours };
      if (colour === undefined) delete colours[slot];
      else colours[slot] = colour;
      return { ...l, colours };
    });

  const nameOk = CHARACTER_NAME_RE.test(name);
  const full = characters.length >= maxCharacters;

  return (
    <div className="flex h-full w-full bg-background text-foreground">
      <div className="flex h-full w-80 shrink-0 flex-col gap-3 overflow-y-auto border-r border-input bg-slate-950 p-4">
        {mode === "list" ? (
          <>
            <div className="font-semibold">{t("character.yours")}</div>
            <div className="space-y-1">
              {characters.map((c) => (
                <button
                  key={c.id}
                  className={`w-full rounded-md border px-3 py-2 text-left text-sm ${c.id === selected ? "border-foreground bg-secondary" : "border-input"}`}
                  onClick={() => setSelected(c.id)}
                  onDoubleClick={() => void run(() => props.onEnter(c.id))}
                >
                  {c.name}
                  <span className="ml-2 text-xs text-muted-foreground">{t(`character.gender.${c.look.gender}`)}</span>
                </button>
              ))}
            </div>
            <Button disabled={busy || selected === null} onClick={() => selected !== null && void run(() => props.onEnter(selected))}>
              {busy ? t("character.entering") : t("character.enter")}
            </Button>
            <Button variant="secondary" disabled={busy || full} onClick={() => setMode("create")}>
              {full ? t("character.slotsUsed", { count: maxCharacters }) : t("character.createNew")}
            </Button>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div className="font-semibold">{t("character.create")}</div>
              {characters.length > 0 && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode("list")}>
                  {t("character.back")}
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              {(["male", "female"] as const).map((g) => (
                <Button key={g} className="flex-1" variant={look.gender === g ? "default" : "outline"} onClick={() => setGender(g)}>
                  {t(`character.gender.${g}`)}
                </Button>
              ))}
            </div>
            {catalog ? (
              <div className="space-y-2">
                {CATEGORIES.filter((c) => !c.gender || c.gender === look.gender).map((c) => (
                  <Picker
                    key={c.slot}
                    label={t(`character.part.${c.slot}`)}
                    options={optionsFor(catalog, c, look.gender)}
                    value={look.parts[c.slot]}
                    onStep={(d) => stepCategory(c, d)}
                  />
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">{artError ? t("character.artUnavailable") : t("character.artLoading")}</div>
            )}
            <div className="space-y-2">
              {COLOUR_ROWS.filter((r) => !r.gender || r.gender === look.gender).map((r) => (
                <Swatches key={r.slot} row={r} value={look.colours[r.slot]} onChange={(c) => setColour(r.slot, c)} />
              ))}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" disabled={!catalog} onClick={() => catalog && setLook(randomLook(catalog, look.gender))}>
                {t("character.randomise")}
              </Button>
              <Button variant="secondary" className="flex-1" onClick={() => setFraming(framing === "body" ? "head" : "body")}>
                {framing === "body" ? t("character.face") : t("character.fullBody")}
              </Button>
            </div>
            <div className="space-y-1">
              <Label htmlFor="character-name">{t("character.name")}</Label>
              <Input
                id="character-name"
                value={name}
                maxLength={16}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && nameOk && !busy) void run(() => props.onCreate(name, look));
                }}
              />
              <p className="text-xs text-muted-foreground">{t("character.nameHint")}</p>
            </div>
            <Button disabled={busy || !nameOk} onClick={() => void run(() => props.onCreate(name, look))}>
              {busy ? t("character.creating") : t("character.createAndEnter")}
            </Button>
          </>
        )}
        {error && <div className="rounded-md border border-input bg-secondary/50 px-3 py-2 text-sm">{error}</div>}
        {artError && <div className="text-xs text-muted-foreground">{artError}</div>}
        <Button size="sm" variant="outline" disabled={busy} onClick={props.onLeave}>
          {t("character.logOut")}
        </Button>
      </div>
      <canvas ref={canvasRef} className="block h-full min-w-0 flex-1" />
    </div>
  );
}
