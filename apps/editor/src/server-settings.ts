/**
 * Server settings forms (roadmap EG13, Live ops › Server settings):
 * content/server/persistence.json as labelled fields. The server reads them
 * when it starts; the editor's Database query uses the query caps at once.
 * Browser-safe.
 */

import type { FieldSectionSpec } from "./rules-control.js";

export const PERSISTENCE_SECTIONS: FieldSectionSpec[] = [
  {
    title: "Saving the world",
    help: "Read when the server starts: restart it to apply a change.",
    fields: [
      { key: "saveEverySeconds", label: "Save every (s)", kind: "number", min: 0, max: 3600, def: 10, help: "Also saved on shutdown. Shorter loses less on a crash and costs more disk writes." },
      { key: "keepSnapshots", label: "Snapshots kept", kind: "number", int: true, min: 1, max: 1000, def: 6, help: "The newest ones; each is a full copy of the world." },
      { key: "walLimitMb", label: "Save log limit (MB)", kind: "number", min: 0, max: 1024, def: 4, help: "The log is cut back to this after each checkpoint." },
    ],
  },
  {
    title: "Database queries",
    help: "The Database › Query view and admin tools. A change applies to the next query.",
    fields: [
      { key: "queryDefaultRows", label: "Rows when none asked", kind: "number", int: true, min: 1, def: 500 },
      { key: "queryMaxRows", label: "Most rows", kind: "number", int: true, min: 1, max: 1000000, def: 5000 },
      { key: "queryTimeoutSeconds", label: "Stop a query after (s)", kind: "number", min: 0, max: 600, def: 2 },
    ],
  },
];
