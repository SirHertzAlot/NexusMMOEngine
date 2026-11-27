/**
 * `@mmo-engine/kit-quests`: what a character is asked to do, and who asks —
 * the third of the engine's kits.
 *
 * Seven files. They were in `@mmo-engine/engine-core` until `ES5o` took the
 * engine's last hold on them: `services.ts` stopped importing the service
 * class and declared the two interfaces it calls instead, the gateway's four
 * inline `as unknown as { ... }` casts became one `QuestExtension`, and
 * `server.ts` gave up holding the quest store to put a character's log on its
 * world record. What was left here was the location.
 *
 * Nothing in the engine imports this package. A game picks it up, forks it,
 * replaces the service and keeps the log, or ignores all of it and writes its
 * own — see the README for what each of those costs.
 *
 * ## What is in it
 *
 * | Export | What it does |
 * | --- | --- |
 * | `QuestService` | The one system: a quest's places and objectives, the giver a player talks to, and the dialogue |
 * | `QuestLog` | The rules of one character's log: what may be accepted, advanced, turned in, abandoned |
 * | `generateQuest` | A quest built from a template for a day and a giver, by constraint solve |
 * | `authoredQuest` | A quest written by hand in `content/quests/`, as the same concrete shape |
 * | `loadQuestContent` | The four content files, parsed and checked |
 * | `SqliteQuestStore` | What a log persists to, plus `MemoryQuestStore` for a harness |
 * | `questRecordsOf` | Which recalled rows are quests: the validator for what rides a world record |
 *
 * plus the worldbuilding a quest reads and writes — pacts, rites, a sick
 * place's treatments, a price due, and the motivations and flaws a giver is
 * composed from.
 *
 * ## What the engine keeps
 *
 * Three things, each declared on the engine's side because neither this kit
 * nor any replacement owns them:
 *
 * - **`QuestService` and `QuestRecords`** in `engine-core/src/services.ts`:
 *   what the host calls, which is `place` and `onDeath`, and the two calls a
 *   character's log rides between a region and the world server. The rows are
 *   `unknown` in both directions — the host moves them and never reads
 *   inside, so `questRecordsOf` is on this side, where the thing that wrote
 *   them is.
 * - **`QuestExtension`** in `engine-core/src/net/extension.ts`: the three
 *   questions the gateway asks of whatever registers under `"quest"`.
 * - **`hash`**, the engine's deterministic mixer, which a generated quest
 *   seeds from so that two runs of the same world agree.
 *
 * A game that replaces this kit writes against those three and nothing else.
 */

export {
  checkQuestContent,
  DEFAULT_QUEST_DIR,
  type DialogAction,
  type DialogCondition,
  type DialogDef,
  type DialogNode,
  type DialogReply,
  DialogsFileSchema,
  EMPTY_QUEST_CONTENT,
  isQuestContentEmpty,
  type NpcDef,
  NpcsFileSchema,
  type Objective,
  parseQuestContent,
  type Place,
  QuestContentError,
  loadQuestContent,
  type QuestContent,
  QuestsFileSchema,
  type QuestTemplate,
  type RewardSpec,
  StepsFileSchema,
  type StepType,
  STRUCTURE_SKINS,
  type StructureSkin,
  type AuthoredQuest,
} from "./content.js";
export { type QuestBindings, QuestGenerationError, generateQuest } from "./generate.js";
export { authoredQuest, concrete, objectiveTarget, type QuestDef, type QuestObjective, type QuestStep } from "./quest-def.js";
export {
  type LogResult,
  MAX_ACTIVE_QUESTS,
  MemoryQuestStore,
  QuestLog,
  type QuestEvent,
  type QuestRecord,
  type QuestStatus,
  type QuestStore,
} from "./quest-log.js";
export { QuestService, type QuestServiceOptions } from "./quest-service.js";
export { questRecordsOf, SqliteQuestStore } from "./quest-store.js";
export {
  advancePact,
  CAUSE_TREATMENTS,
  CHARACTER_FLAWS,
  CHARACTER_MOTIVATIONS,
  type CharacterFlaw,
  type CharacterMotivation,
  composeGiverProfile,
  type GiverQuestSignature,
  type NpcArcSpec,
  type Pact,
  type PactAction,
  PactSchema,
  type PactState,
  PACT_STATES,
  pactDueQuest,
  performRite,
  priceDueOptions,
  type RiteDef,
  RiteSchema,
  riteQuest,
  treatSickPlace,
} from "./worldbuilding-generics.js";
