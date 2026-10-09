/**
 * VFX and materials workspace (roadmap EA22), over the real documents:
 *
 *  - Effects: content/vfx/effects.json. The composer's particle effects,
 *    the weather and the splash, tuned with a live preview that emits
 *    what the client would under a tier's multiplier and live-particle
 *    cap, two tiers side by side, and every effect against every tier's
 *    budget.
 *  - Tiers: content/vfx/tiers.json. The quality presets (resolution,
 *    MSAA, bloom, ambient occlusion, sky, outlines, particle multiplier and
 *    budgets), with a compare view that marks what differs.
 *  - Materials: content/materials/materials.json. The toon look (band
 *    edges, highlight, rim, shadow ramp per material, day and night) and
 *    the terrain surfaces' tint, tile size and footstep sound.
 *
 * The client reads all three at start; reload the client to see a change.
 */
import * as React from "react";
import {
  QUALITY_TIER_NAMES, TOON_ROW_NAMES, budgetReport,
  type AudioDoc, type MaterialsDoc, type ParticleEffect, type Rgb, type TierName, type TierPreset, type TiersDoc, type VfxDoc, type WeatherEffect,
} from "@mmo-engine/art/browser";
import { getMedia } from "../media-client.js";
import { ParticlePreview, hexToLinear, linearToHex, previewLife, previewRate, toonColour, type PreviewKind } from "../vfx-model.js";
import { Colour, H, Num, Pick, SaveBar, Segmented, Text, Toggle, btn, mediaStore, muted, useMediaDoc, usePublish, useSaveAction } from "./media-common.js";
import { detailStore } from "./media-details.js";

export function VfxPanel(): React.JSX.Element {
  const { vfxTab } = mediaStore.use();
  const vfx = useMediaDoc("vfx");
  const tiers = useMediaDoc("tiers");
  const materials = useMediaDoc("materials");
  useSaveAction("vfx and materials", [vfx, tiers, materials]);
  usePublish({ effects: vfx.doc ? [...Object.keys(vfx.doc.effects), ...Object.keys(vfx.doc.weather).map((k) => `weather.${k}`), "splash"] : [] });
  const active = vfxTab === "effects" ? vfx : vfxTab === "tiers" ? tiers : materials;
  const file = vfxTab === "effects" ? "content/vfx/effects.json" : vfxTab === "tiers" ? "content/vfx/tiers.json" : "content/materials/materials.json";
  return (
    <div className="flex flex-col gap-3 p-3" style={{ color: "var(--m3-on-surface)" }}>
      <Segmented
        label="VFX views" value={vfxTab} onChange={(v) => mediaStore.set((p) => ({ ...p, vfxTab: v }))}
        options={[["effects", "Particle effects"], ["tiers", "Tier presets"], ["materials", "Materials"]]}
      />
      <SaveBar file={file} dirty={active.dirty} issues={active.issues} status={active.status} onSave={() => void active.save()} onRevert={active.revert} />
      {vfxTab === "effects" && vfx.doc && tiers.doc && <EffectsEditor vfx={vfx.doc} tiers={tiers.doc} onChange={vfx.set} />}
      {vfxTab === "tiers" && tiers.doc && <TiersEditor doc={tiers.doc} onChange={tiers.set} />}
      {vfxTab === "materials" && materials.doc && <MaterialsEditor doc={materials.doc} onChange={materials.set} />}
      {!active.doc && <p className="text-[13px]" style={muted}>{active.status || "loading…"}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- effects

function previewOf(vfx: VfxDoc, id: string): PreviewKind | null {
  if (id === "splash") return { kind: "splash", splash: vfx.splash };
  if (id.startsWith("weather.")) {
    const w = vfx.weather[id.slice(8) as keyof VfxDoc["weather"]];
    return w ? { kind: "weather", weather: w } : null;
  }
  const e = vfx.effects[id];
  return e ? { kind: "effect", effect: e } : null;
}

function EffectsEditor({ vfx, tiers, onChange }: { vfx: VfxDoc; tiers: TiersDoc; onChange: (v: VfxDoc) => void }): React.JSX.Element {
  const { effect: picked } = mediaStore.use();
  const id = previewOf(vfx, picked) ? picked : Object.keys(vfx.effects)[0];
  const preview = previewOf(vfx, id)!;
  const [a, setA] = React.useState<TierName>("low");
  const [b, setB] = React.useState<TierName>("ultra");
  const rows = React.useMemo(() => budgetReport(vfx, tiers), [vfx, tiers]);
  const row = rows.find((r) => r.id === id);
  React.useEffect(() => {
    detailStore.set({
      title: id,
      rows: [
        ["kind", preview.kind],
        ["rate", `${previewRate(preview).toFixed(1)} /s`],
        ["life", `${previewLife(preview).toFixed(2)} s`],
        ...(row ? QUALITY_TIER_NAMES.map((t): [string, string] => [`live @ ${t}`, `${Math.round(row.live[t])} / ${row.budget[t]}${row.over.includes(t) ? " OVER" : ""}`]) : []),
      ],
      note: "Live counts are rate x tier multiplier x mean life; the client holds each effect under the tier's budget.",
    });
  });
  const setEffect = (e: ParticleEffect): void => onChange({ ...vfx, effects: { ...vfx.effects, [id]: e } });
  const setWeather = (w: WeatherEffect): void => onChange({ ...vfx, weather: { ...vfx.weather, [id.slice(8)]: w } as VfxDoc["weather"] });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Pick label="Effect" value={id} options={[...Object.keys(vfx.effects), ...Object.keys(vfx.weather).map((k) => `weather.${k}`), "splash"]} onChange={(v) => mediaStore.set((p) => ({ ...p, effect: v }))} />
        {preview.kind === "effect" && <button className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} onClick={() => onChange({ ...vfx, effects: Object.fromEntries(Object.entries(vfx.effects).filter(([k]) => k !== id)) })} disabled={Object.keys(vfx.effects).length < 2}>Delete effect</button>}
        <NewEffect vfx={vfx} onAdd={(name) => { onChange({ ...vfx, effects: { ...vfx.effects, [name]: structuredClone(vfx.effects[id] ?? Object.values(vfx.effects)[0]) } }); mediaStore.set((p) => ({ ...p, effect: name })); }} />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <TierPreview label={a} tierName={a} tiers={tiers} preview={preview} onTier={setA} />
        <TierPreview label={b} tierName={b} tiers={tiers} preview={preview} onTier={setB} />
      </div>

      {preview.kind === "effect" && <EffectForm e={preview.effect} onChange={setEffect} />}
      {preview.kind === "weather" && <WeatherForm w={preview.weather} onChange={setWeather} />}
      {preview.kind === "splash" && <SplashForm vfx={vfx} onChange={onChange} />}

      <H>Tier budgets</H>
      <table className="w-full text-left text-[12px]" aria-label="tier budgets">
        <thead style={muted}><tr><th className="py-1">Effect</th>{QUALITY_TIER_NAMES.map((t) => <th key={t}>{t}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} onClick={() => mediaStore.set((p) => ({ ...p, effect: r.id }))} className="cursor-pointer" data-over={r.over.length > 0}>
              <td className="py-0.5 font-mono">{r.id}</td>
              {QUALITY_TIER_NAMES.map((t) => (
                <td key={t} className="font-mono" style={r.over.includes(t) ? { color: "#E8A33D" } : undefined}>{Math.round(r.live[t])} / {r.budget[t]}{r.over.includes(t) ? " over" : ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.some((r) => r.over.length > 0) && <p className="text-[12px]" style={{ color: "#E8A33D" }}>Over budget: the client lowers the emission rate to fit, so the effect thins out at that tier. Lower its rate or life to keep its look.</p>}
    </div>
  );
}

function NewEffect({ vfx, onAdd }: { vfx: VfxDoc; onAdd: (name: string) => void }): React.JSX.Element {
  const [name, setName] = React.useState("");
  const ok = /^[a-z0-9][a-z0-9-]*$/.test(name) && !(name in vfx.effects);
  return (
    <span className="flex items-end gap-1">
      <Text label="New effect (copy of this)" value={name} onChange={setName} />
      <button className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} disabled={!ok} onClick={() => { onAdd(name); setName(""); }}>Add</button>
    </span>
  );
}

/** One preview canvas for a tier: the effect as the client would emit it there, with its live count against the budget. */
function TierPreview({ label, tierName, tiers, preview, onTier }: { label: string; tierName: TierName; tiers: TiersDoc; preview: PreviewKind; onTier: (t: TierName) => void }): React.JSX.Element {
  const canvas = React.useRef<HTMLCanvasElement | null>(null);
  const tier = tiers.tiers[tierName];
  const cap = preview.kind === "weather" ? tier.weatherBudget : tier.effectBudget;
  const sim = React.useRef<ParticlePreview | null>(null);
  const [live, setLive] = React.useState(0);
  const latest = React.useRef({ preview, tier, cap });
  latest.current = { preview, tier, cap };
  React.useEffect(() => {
    const ctx = canvas.current!.getContext("2d")!;
    sim.current = new ParticlePreview(latest.current.preview, { particles: latest.current.tier.particles, cap: latest.current.cap });
    let last = performance.now();
    let raf = 0;
    let n = 0;
    const frame = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { preview: p, tier: t, cap: c } = latest.current;
      sim.current!.setParams(p, { particles: t.particles, cap: c });
      sim.current!.step(dt);
      const w = canvas.current!.width;
      const h = canvas.current!.height;
      ctx.fillStyle = "#14151a";
      ctx.fillRect(0, 0, w, h);
      const scale = p.kind === "weather" ? 22 : p.kind === "splash" ? 40 : 60;
      const colour = p.kind === "effect" ? p.effect.color : p.kind === "weather" ? [p.weather.color, p.weather.color] : [p.splash.color, p.splash.color];
      const add = p.kind === "effect" && p.effect.blending === "additive";
      ctx.globalCompositeOperation = add ? "lighter" : "source-over";
      for (const d of sim.current!.dots) {
        const k = d.age / d.life;
        const alpha = p.kind === "effect" ? (k < 0.25 ? p.effect.alpha[0] + (p.effect.alpha[1] - p.effect.alpha[0]) * (k / 0.25) : p.effect.alpha[1] + (p.effect.alpha[2] - p.effect.alpha[1]) * ((k - 0.25) / 0.75)) : p.kind === "weather" ? p.weather.alpha : p.splash.alpha;
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        ctx.fillStyle = k < 0.5 ? colour[0] : colour[1];
        const r = Math.max(1.2, d.size * scale * 0.6);
        ctx.beginPath();
        ctx.arc(w / 2 + d.x * scale, h - 14 - d.y * scale * (p.kind === "weather" ? 1 : 1), r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      if (++n % 6 === 0) setLive(sim.current!.dots.length);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  const over = live > cap * 1.02;
  return (
    <div className="rounded-xl p-2" style={{ background: "var(--m3-surface-2)" }} data-tier-preview={tierName}>
      <div className="mb-1 flex items-center gap-2">
        <Pick label="Tier" value={tierName} options={QUALITY_TIER_NAMES} onChange={onTier} />
        <span className="ml-auto font-mono text-[12px]" aria-label={`${label} particle count`} style={over ? { color: "#E8A33D" } : undefined}>
          {live} live / {cap} · x{tier.particles}
        </span>
      </div>
      <canvas ref={canvas} width={420} height={220} className="w-full rounded-lg" aria-label={`${label} preview`} />
    </div>
  );
}

const SHAPES = ["sphere", "cone", "ring"] as const;
const BLENDS = ["additive", "normal"] as const;
const TEXTURES = ["soft", "spark"] as const;

function EffectForm({ e, onChange }: { e: ParticleEffect; onChange: (e: ParticleEffect) => void }): React.JSX.Element {
  const pair = (k: "size" | "life" | "speed", i: 0 | 1, v: number): void => onChange({ ...e, [k]: i === 0 ? [v, e[k][1]] : [e[k][0], v] });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-3">
        <Num label="Rate" unit="/s" value={e.rate} min={0} max={5000} step={1} onChange={(rate) => onChange({ ...e, rate })} />
        <Num label="Life min" unit="s" value={e.life[0]} min={0.05} step={0.1} onChange={(v) => pair("life", 0, v)} />
        <Num label="Life max" unit="s" value={e.life[1]} min={0.05} step={0.1} onChange={(v) => pair("life", 1, v)} />
        <Num label="Speed min" unit="m/s" value={e.speed[0]} min={0} step={0.05} onChange={(v) => pair("speed", 0, v)} />
        <Num label="Speed max" unit="m/s" value={e.speed[1]} min={0} step={0.05} onChange={(v) => pair("speed", 1, v)} />
        <Num label="Size min" unit="m" value={e.size[0]} min={0.005} step={0.01} onChange={(v) => pair("size", 0, v)} />
        <Num label="Size max" unit="m" value={e.size[1]} min={0.005} step={0.01} onChange={(v) => pair("size", 1, v)} />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Colour label="Start colour" value={e.color[0]} onChange={(c) => onChange({ ...e, color: [c, e.color[1]] })} />
        <Colour label="End colour" value={e.color[1]} onChange={(c) => onChange({ ...e, color: [e.color[0], c] })} />
        <Num label="Opacity at birth" value={e.alpha[0]} min={0} max={1} step={0.05} onChange={(v) => onChange({ ...e, alpha: [v, e.alpha[1], e.alpha[2]] })} />
        <Num label="Opacity at peak" value={e.alpha[1]} min={0} max={1} step={0.05} onChange={(v) => onChange({ ...e, alpha: [e.alpha[0], v, e.alpha[2]] })} />
        <Num label="Opacity at death" value={e.alpha[2]} min={0} max={1} step={0.05} onChange={(v) => onChange({ ...e, alpha: [e.alpha[0], e.alpha[1], v] })} />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Pick label="Shape" value={e.shape} options={SHAPES} onChange={(shape) => onChange({ ...e, shape })} />
        <Num label="Emitter radius" unit="m" value={e.radius} min={0} step={0.05} onChange={(radius) => onChange({ ...e, radius })} />
        <Num label="Lift" unit="m/s²" value={e.lift} step={0.1} onChange={(lift) => onChange({ ...e, lift })} />
        <Num label="Wander" value={e.wander} min={0} step={0.05} onChange={(wander) => onChange({ ...e, wander })} />
        <Num label="Orbit" unit="rad/s" value={e.orbit ?? 0} step={0.1} onChange={(orbit) => onChange(orbit === 0 ? omitOrbit(e) : { ...e, orbit })} />
        <Pick label="Blending" value={e.blending} options={BLENDS} onChange={(blending) => onChange({ ...e, blending })} />
        <Pick label="Texture" value={e.texture} options={TEXTURES} onChange={(texture) => onChange({ ...e, texture })} />
      </div>
    </div>
  );
}

function omitOrbit(e: ParticleEffect): ParticleEffect {
  const { orbit: _o, ...rest } = e;
  return rest;
}

function WeatherForm({ w, onChange }: { w: WeatherEffect; onChange: (w: WeatherEffect) => void }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Num label="Rate" unit="/s" value={w.rate} min={0} max={5000} step={10} onChange={(rate) => onChange({ ...w, rate })} />
      <Num label="Life" unit="s" value={w.life} min={0.1} step={0.1} onChange={(life) => onChange({ ...w, life })} />
      <Num label="Fall speed" unit="m/s" value={w.fall} step={0.1} onChange={(fall) => onChange({ ...w, fall })} />
      <Num label="Size" unit="m" value={w.size} min={0.01} step={0.01} onChange={(size) => onChange({ ...w, size })} />
      <Num label="Opacity" value={w.alpha} min={0} max={1} step={0.05} onChange={(alpha) => onChange({ ...w, alpha })} />
      <Num label="Drift" value={w.drift} min={0} step={0.05} onChange={(drift) => onChange({ ...w, drift })} />
      <Colour label="Colour" value={w.color} onChange={(color) => onChange({ ...w, color })} />
      <Pick label="Texture" value={w.texture} options={["soft", "streak"] as const} onChange={(texture) => onChange({ ...w, texture })} />
    </div>
  );
}

function SplashForm({ vfx, onChange }: { vfx: VfxDoc; onChange: (v: VfxDoc) => void }): React.JSX.Element {
  const s = vfx.splash;
  const set = (patch: Partial<VfxDoc["splash"]>): void => onChange({ ...vfx, splash: { ...s, ...patch } });
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Num label="Droplets" value={s.count} min={0} step={1} onChange={(count) => set({ count })} />
      <Num label="Life" unit="s" value={s.life} min={0.05} step={0.05} onChange={(life) => set({ life })} />
      <Num label="Speed" unit="m/s" value={s.speed} min={0} step={0.1} onChange={(speed) => set({ speed })} />
      <Num label="Spread" unit="deg" value={s.spreadDeg} min={0} max={180} step={1} onChange={(spreadDeg) => set({ spreadDeg })} />
      <Num label="Size" unit="m" value={s.size} min={0.01} step={0.01} onChange={(size) => set({ size })} />
      <Num label="Opacity" value={s.alpha} min={0} max={1} step={0.05} onChange={(alpha) => set({ alpha })} />
      <Num label="Gravity" unit="m/s²" value={s.gravity} min={0} step={0.5} onChange={(gravity) => set({ gravity })} />
      <Num label="Every" unit="s" value={s.everySeconds} min={0.05} step={0.05} onChange={(everySeconds) => set({ everySeconds })} />
      <Colour label="Colour" value={s.color} onChange={(color) => set({ color })} />
    </div>
  );
}

// ---------------------------------------------------------------- tiers

const AO_QUALITY = ["performance", "low", "medium", "high", "ultra"] as const;
const SKIES = ["classic", "physical"] as const;

function TiersEditor({ doc, onChange }: { doc: TiersDoc; onChange: (d: TiersDoc) => void }): React.JSX.Element {
  const [a, setA] = React.useState<TierName>("medium");
  const [b, setB] = React.useState<TierName>("high");
  const set = (t: TierName, patch: Partial<TierPreset>): void => onChange({ ...doc, tiers: { ...doc.tiers, [t]: { ...doc.tiers[t], ...patch } } });
  React.useEffect(() => {
    detailStore.set({
      title: "Tier presets",
      rows: QUALITY_TIER_NAMES.map((t): [string, string] => [t, `x${doc.tiers[t].particles} particles · ${doc.tiers[t].effects ? "post on" : "post off"} · ${doc.tiers[t].sky}`]),
      note: "The client picks a tier from the GPU and the frame rate, and the player can pin one.",
    });
  });
  const flat = (t: TierPreset): Record<string, string> => ({
    "resolution scale": `${t.dpr[0]}–${t.dpr[1]}`, "post effects": String(t.effects), MSAA: String(t.msaa), bloom: String(t.bloom),
    "ambient occlusion": t.ao ? `${t.ao.quality}${t.ao.halfRes ? ", half res" : ""}` : "off", "particle multiplier": `x${t.particles}`,
    outlines: String(t.outlines), sky: t.sky, "effect budget": String(t.effectBudget), "weather budget": String(t.weatherBudget),
  });
  const fa = flat(doc.tiers[a]);
  const fb = flat(doc.tiers[b]);
  return (
    <div className="flex flex-col gap-4">
      {QUALITY_TIER_NAMES.map((name) => {
        const t = doc.tiers[name];
        return (
          <div key={name} className="flex flex-wrap items-end gap-3 rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }} data-tier={name}>
            <strong className="w-16 text-[13px]">{name}</strong>
            <Num label={`${name} min scale`} value={t.dpr[0]} min={0.25} max={4} step={0.25} onChange={(v) => set(name, { dpr: [v, t.dpr[1]] })} />
            <Num label={`${name} max scale`} value={t.dpr[1]} min={0.25} max={4} step={0.25} onChange={(v) => set(name, { dpr: [t.dpr[0], v] })} />
            <Num label={`${name} MSAA`} value={t.msaa} min={0} max={8} step={2} onChange={(msaa) => set(name, { msaa })} />
            <Num label={`${name} particles`} unit="x" value={t.particles} min={0} max={4} step={0.1} onChange={(particles) => set(name, { particles })} />
            <Num label={`${name} effect budget`} value={t.effectBudget} min={0} step={50} onChange={(effectBudget) => set(name, { effectBudget })} />
            <Num label={`${name} weather budget`} value={t.weatherBudget} min={0} step={250} onChange={(weatherBudget) => set(name, { weatherBudget })} />
            <Toggle label={`${name} post effects`} value={t.effects} onChange={(effects) => set(name, { effects })} />
            <Toggle label={`${name} bloom`} value={t.bloom} onChange={(bloom) => set(name, { bloom })} />
            <Toggle label={`${name} outlines`} value={t.outlines} onChange={(outlines) => set(name, { outlines })} />
            <Pick label={`${name} sky`} value={t.sky} options={SKIES} onChange={(sky) => set(name, { sky })} />
            <Toggle label={`${name} ambient occlusion`} value={t.ao !== false} onChange={(on) => set(name, { ao: on ? { quality: "medium", halfRes: true } : false })} />
            {t.ao && <Pick label={`${name} AO quality`} value={t.ao.quality} options={AO_QUALITY} onChange={(quality) => set(name, { ao: { quality, halfRes: (t.ao as { halfRes: boolean }).halfRes } })} />}
            {t.ao && <Toggle label={`${name} AO half resolution`} value={t.ao.halfRes} onChange={(halfRes) => set(name, { ao: { quality: (t.ao as { quality: (typeof AO_QUALITY)[number] }).quality, halfRes } })} />}
          </div>
        );
      })}
      <H>Compare</H>
      <div className="flex items-end gap-3">
        <Pick label="Left" value={a} options={QUALITY_TIER_NAMES} onChange={setA} />
        <Pick label="Right" value={b} options={QUALITY_TIER_NAMES} onChange={setB} />
      </div>
      <table className="w-full text-left text-[12px]" aria-label="tier compare">
        <thead style={muted}><tr><th className="py-1">Setting</th><th>{a}</th><th>{b}</th></tr></thead>
        <tbody>
          {Object.keys(fa).map((k) => (
            <tr key={k} data-differs={fa[k] !== fb[k]} style={fa[k] !== fb[k] ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : undefined}>
              <td className="py-0.5">{k}</td><td className="font-mono">{fa[k]}</td><td className="font-mono">{fb[k]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- materials

function MaterialsEditor({ doc, onChange }: { doc: MaterialsDoc; onChange: (d: MaterialsDoc) => void }): React.JSX.Element {
  const [events, setEvents] = React.useState<string[]>([]);
  const [night, setNight] = React.useState(false);
  const [row, setRow] = React.useState<(typeof TOON_ROW_NAMES)[number]>("cloth");
  React.useEffect(() => {
    getMedia("audio").then((a: AudioDoc) => setEvents(Object.keys(a.events))).catch(() => setEvents([]));
  }, []);
  const toon = doc.toon;
  const setToon = (patch: Partial<MaterialsDoc["toon"]>): void => onChange({ ...doc, toon: { ...toon, ...patch } });
  const setEdge = (r: (typeof TOON_ROW_NAMES)[number], when: "day" | "night", i: 0 | 1, hex: string): void => {
    const pair: [Rgb, Rgb] = [...toon.ramp[r][when]];
    pair[i] = hexToLinear(hex);
    setToon({ ramp: { ...toon.ramp, [r]: { ...toon.ramp[r], [when]: pair } } });
  };
  React.useEffect(() => {
    detailStore.set({
      title: "Materials",
      rows: [["band", toon.band.join(" – ")], ["rim", `${toon.rim} (power ${toon.rimPower})`], ["surfaces", String(Object.keys(doc.surfaces).length)], ["ramp rows", TOON_ROW_NAMES.join(", ")]],
      note: "Toon materials start from these values; terrain surfaces take their tint and tile size when the surface set loads.",
    });
  });
  return (
    <div className="flex flex-col gap-3">
      <H>Toon shading</H>
      <div className="flex flex-wrap items-end gap-3">
        <Num label="Shadow edge" value={toon.band[0]} min={0} max={1} step={0.01} onChange={(v) => setToon({ band: [v, toon.band[1]] })} />
        <Num label="Lit edge" value={toon.band[1]} min={0} max={1} step={0.01} onChange={(v) => setToon({ band: [toon.band[0], v] })} />
        <Num label="Highlight" value={toon.specular} min={0} max={1} step={0.01} onChange={(specular) => setToon({ specular })} />
        <Num label="Rim light" value={toon.rim} min={0} max={2} step={0.05} onChange={(rim) => setToon({ rim })} />
        <Num label="Rim power" value={toon.rimPower} min={0.5} max={32} step={0.5} onChange={(rimPower) => setToon({ rimPower })} />
        <Toggle label="Night ramp" value={night} onChange={setNight} />
      </div>
      <div className="flex flex-wrap gap-4">
        <ToonBall toon={toon} row={row} night={night} />
        <div className="flex flex-col gap-2">
          {TOON_ROW_NAMES.map((r) => {
            const pair = toon.ramp[r][night ? "night" : "day"];
            return (
              <div key={r} className="flex items-center gap-2" data-ramp={r}>
                <button className={btn} style={r === row ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { border: "1px solid var(--m3-outline-variant)" }} onClick={() => setRow(r)}>{r}</button>
                <Colour label={`${r} darkest shadow`} value={linearToHex(pair[0])} onChange={(h) => setEdge(r, night ? "night" : "day", 0, h)} />
                <Colour label={`${r} shadow edge`} value={linearToHex(pair[1])} onChange={(h) => setEdge(r, night ? "night" : "day", 1, h)} />
                <span className="h-5 w-32 rounded" style={{ background: `linear-gradient(90deg, ${linearToHex(pair[0])}, ${linearToHex(pair[1])})` }} aria-hidden />
              </div>
            );
          })}
        </div>
      </div>
      <H>Surfaces</H>
      <datalist id="step-events">{events.map((e) => <option key={e} value={e} />)}</datalist>
      <div className="flex flex-col gap-1.5">
        {Object.entries(doc.surfaces).map(([sid, s]) => (
          <div key={sid} className="flex flex-wrap items-end gap-2" data-surface={sid}>
            <span className="w-28 font-mono text-[12px]">{sid}</span>
            <span className="h-6 w-8 rounded" style={{ background: linearToHex(s.tint.map((v) => Math.min(1, v * 0.5)) as Rgb) }} aria-hidden />
            {([0, 1, 2] as const).map((i) => (
              <Num key={i} label={`${sid} tint ${"rgb"[i]}`} value={s.tint[i]} min={0} max={4} step={0.05} onChange={(v) => onChange({ ...doc, surfaces: { ...doc.surfaces, [sid]: { ...s, tint: s.tint.map((x, k) => (k === i ? v : x)) as Rgb } } })} />
            ))}
            <Num label={`${sid} tile`} unit="m" value={s.tileMetres ?? NaN} min={0.1} step={0.5} onChange={(tileMetres) => onChange({ ...doc, surfaces: { ...doc.surfaces, [sid]: { ...s, tileMetres } } })} />
            <Text label={`${sid} footstep`} value={s.footstep ?? ""} list="step-events" onChange={(v) => onChange({ ...doc, surfaces: { ...doc.surfaces, [sid]: withFootstep(s, v) } })} />
          </div>
        ))}
      </div>
    </div>
  );
}

function withFootstep(s: MaterialsDoc["surfaces"][string], v: string): MaterialsDoc["surfaces"][string] {
  const { footstep: _f, ...rest } = s;
  return v === "" ? rest : { ...rest, footstep: v };
}

/** A lit ball in the material's toon look, one band and ramp row at a time. */
function ToonBall({ toon, row, night }: { toon: MaterialsDoc["toon"]; row: (typeof TOON_ROW_NAMES)[number]; night: boolean }): React.JSX.Element {
  const ref = React.useRef<HTMLCanvasElement | null>(null);
  React.useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    const n = c.width;
    const img = ctx.createImageData(n, n);
    const light = [0.55, 0.55, 0.63];
    const len = Math.hypot(...light);
    const base: Rgb = [0.85, 0.8, 0.75];
    const ramp = toon.ramp[row][night ? "night" : "day"];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const px = (x / (n - 1)) * 2 - 1;
        const py = 1 - (y / (n - 1)) * 2;
        const r2 = px * px + py * py;
        const o = (y * n + x) * 4;
        if (r2 > 1) {
          img.data[o + 3] = 0;
          continue;
        }
        const nz = Math.sqrt(1 - r2);
        const col = toonColour((px * light[0] + py * light[1] + nz * light[2]) / len, nz, base, ramp, toon);
        const hex = linearToHex(col);
        img.data[o] = parseInt(hex.slice(1, 3), 16);
        img.data[o + 1] = parseInt(hex.slice(3, 5), 16);
        img.data[o + 2] = parseInt(hex.slice(5, 7), 16);
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [toon, row, night]);
  return <canvas ref={ref} width={140} height={140} className="rounded-xl" style={{ background: "var(--m3-surface-0)" }} aria-label={`${row} toon preview`} />;
}
