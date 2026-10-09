// Test helper: gives t() the real English table, as main.tsx does in the browser.
import { readFileSync } from "node:fs";
import type { StringsBundle } from "@mmo-engine/scene";
import { initI18n } from "../src/i18n.js";

export const en = JSON.parse(readFileSync(new URL("../../../../content/strings/en.json", import.meta.url), "utf8")) as StringsBundle;
initI18n({ en });
