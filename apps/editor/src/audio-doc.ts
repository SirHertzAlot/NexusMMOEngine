/**
 * Audio document edits (EA24): the pure half of the Audio panel. The panel
 * holds a `SoundBank` (the client's parsed events.json); these functions
 * return the next bank for each edit and the JSON to save, so none of it
 * needs a browser.
 */

import type { BusSettings, EventBus, SoundBank, SoundEvent, Variation } from "@mmo-engine/client/audio";

const replaceEvent = (bank: SoundBank, name: string, next: (e: SoundEvent) => SoundEvent): SoundBank => ({
  ...bank,
  events: bank.events.map((e) => (e.name === name ? next(e) : e)),
});

/** The clips of an event, whether it names one file or weighted variations. */
export const clipsOf = (e: SoundEvent): Variation[] => e.variations ?? (e.file ? [{ file: e.file, weight: 1 }] : []);

/** One clip is a plain `file`; several are `variations`. */
function withClips(e: SoundEvent, clips: Variation[]): SoundEvent {
  const { file: _file, variations: _variations, ...rest } = e;
  return clips.length > 1 ? { ...rest, variations: clips } : { ...rest, file: clips[0]?.file ?? "" };
}

export function patchEvent(bank: SoundBank, name: string, patch: Partial<Omit<SoundEvent, "file" | "variations">>): SoundBank {
  return replaceEvent(bank, name, (e) => ({ ...e, ...patch }));
}

export function setClip(bank: SoundBank, name: string, index: number, patch: Partial<Variation>): SoundBank {
  return replaceEvent(bank, name, (e) => withClips(e, clipsOf(e).map((c, i) => (i === index ? { ...c, ...patch } : c))));
}

export function addClip(bank: SoundBank, name: string): SoundBank {
  return replaceEvent(bank, name, (e) => withClips(e, [...clipsOf(e), { file: "new-clip.ogg", weight: 1 }]));
}

/** The last clip cannot be removed: an event needs a file. */
export function removeClip(bank: SoundBank, name: string, index: number): SoundBank {
  return replaceEvent(bank, name, (e) => {
    const clips = clipsOf(e);
    return clips.length <= 1 ? e : withClips(e, clips.filter((_, i) => i !== index));
  });
}

export function setBus(bank: SoundBank, bus: EventBus, patch: Partial<BusSettings>): SoundBank {
  return { ...bank, buses: { ...bank.buses, [bus]: { ...bank.buses[bus], ...patch } } };
}

/** A new event with a name that is not taken yet ("new-event", "new-event-2", …). */
export function addEvent(bank: SoundBank): { bank: SoundBank; name: string } {
  const taken = new Set(bank.events.map((e) => e.name));
  let name = "new-event";
  for (let n = 2; taken.has(name); n++) name = `new-event-${n}`;
  const event: SoundEvent = { name, bus: "interface", file: "new-clip.ogg", volume: 0.7, positional: false, maxDistance: 40, pitchRange: [1, 1], priority: 0 };
  return { bank: { ...bank, events: [...bank.events, event] }, name };
}

export const removeEvent = (bank: SoundBank, name: string): SoundBank => ({ ...bank, events: bank.events.filter((e) => e.name !== name) });

/** What is wrong with the bank, before the host says it too: [event name or "", message]. */
export function problems(bank: SoundBank): { event: string; message: string }[] {
  const out: { event: string; message: string }[] = [];
  const seen = new Set<string>();
  for (const e of bank.events) {
    if (!e.name.trim()) out.push({ event: e.name, message: "an event has no name" });
    else if (seen.has(e.name)) out.push({ event: e.name, message: `duplicate event "${e.name}"` });
    seen.add(e.name);
    const clips = clipsOf(e);
    if (clips.some((c) => !c.file.trim())) out.push({ event: e.name, message: `${e.name}: a clip has no file` });
    if (clips.length > 1 && clips.every((c) => c.weight === 0)) out.push({ event: e.name, message: `${e.name}: every variation has weight 0` });
  }
  return out;
}

/** The document to save: the same shape events.json has, stable key order. */
export function toDocument(bank: SoundBank): unknown {
  return { buses: bank.buses, events: bank.events.map((e) => ({ ...e })) };
}
