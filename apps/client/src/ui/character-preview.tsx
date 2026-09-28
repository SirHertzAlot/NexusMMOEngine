/**
 * Dev preview of the character screen with no server (open the client
 * with `?preview=character`): creating a character adds it to a local
 * list instead of the server's, and entering the world just says so.
 */

import { useState } from "react";
import { lookToJson, type CharacterLook } from "@mmo-engine/art/browser";
import type { CharacterEntry } from "@mmo-engine/protocol";
import { CharacterScreen } from "./character-screen.js";

export function CharacterPreview(): React.ReactElement {
  const [characters, setCharacters] = useState<CharacterEntry[]>([]);
  const [note, setNote] = useState<string | null>(null);
  // Remount the screen after a create so it opens on the list.
  const [generation, setGeneration] = useState(0);

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
      />
      {note && (
        <div className="absolute bottom-4 right-4 max-w-md break-all rounded-md bg-black/70 px-3 py-2 text-xs text-foreground">
          {note}
        </div>
      )}
    </div>
  );
}
