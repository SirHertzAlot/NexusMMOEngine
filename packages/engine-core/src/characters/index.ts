/**
 * Characters — an account's playable characters: storage and the rules
 * for creating one. The gateway depends on these; the sim only sees the
 * Appearance component they produce.
 */

export {
  CharacterRefusedError,
  DEFAULT_CHARACTERS_DB_PATH,
  MemoryCharacterStore,
  SqliteCharacterStore,
  nameKey,
} from "./store.js";
export type { CharacterRecord, CharacterRefusal, CharacterState, CharacterStore } from "./store.js";
export {
  CHARACTER_NAME_RE,
  CreateCharacterSchema,
  DEFAULT_LOOK_JSON,
  DEFAULT_MAX_CHARACTERS,
  EnterWorldSchema,
  MAX_CREATE_PAYLOAD_BYTES,
  checkNewLook,
  loadCharacterCatalog,
} from "./rules.js";
