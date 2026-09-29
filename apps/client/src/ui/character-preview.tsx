/**
 * Dev preview of the character screen with no server (open the client
 * with `?preview=character`): creating a character adds it to a local
 * list instead of the server's, and entering the world just says so.
 */

import { useEffect, useState } from "react";
import { lookToJson, type AnimationManifest, type CharacterLook } from "@mmo-engine/art/browser";
import { DEFAULT_KIT_URL } from "../render/character/character-kit.js";
import type { CharacterEntry } from "@mmo-engine/protocol";
import { CharacterScreen } from "./character-screen.js";

export function CharacterPreview(): React.ReactElement {
  const [characters, setCharacters] = useState<CharacterEntry[]>([]);
  const [note, setNote] = useState<string | null>(null);
  // Remount the screen after a create so it opens on the list.
  const [generation, setGeneration] = useState(0);
  // Every retargeted clip, to check them by eye.
  const [clips, setClips] = useState<string[]>([]);
  const [clip, setClip] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${DEFAULT_KIT_URL}animations.json`)
      .then((r) => (r.ok ? (r.json() as Promise<AnimationManifest>) : null))
      .then((m) => setClips(m ? m.clips.map((c) => c.name) : []))
      .catch(() => setClips([]));
  }, []);

  const create = async (name: string, look: CharacterLook): Promise<void> => {
    if (characters.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new Error("that name is taken");
    const entry: CharacterEntry = { id: characters.length + 1, name, look: JSON.parse(lookToJson(look)) };
    setCharacters([...characters, entry]);
    setNote(`created ${name}: ${lookToJson(look)}`);
    setGeneration(generation + 1);
  };

  return (
    <div className="relative h-screen w-screen">
      <CharacterScreen
        key={generation}
        characters={characters}
        maxCharacters={8}
        onCreate={create}
        onEnter={async (id) => setNote(`would enter the world as character ${id}`)}
        onLeave={() => setNote("would log out")}
        previewClip={clip}
        referenceClips
      />
      {clips.length > 0 && (
        <select
          id="preview-clip"
          aria-label="animation"
          className="absolute right-4 top-4 rounded-md border border-input bg-slate-950 px-2 py-1 text-sm text-foreground"
          value={clip ?? ""}
          onChange={(e) => setClip(e.target.value || null)}
        >
          <option value="">idle</option>
          {clips.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}
      {note && (
        <div className="absolute bottom-4 right-4 max-w-md break-all rounded-md bg-black/70 px-3 py-2 text-xs text-foreground">
          {note}
        </div>
      )}
    </div>
  );
}
