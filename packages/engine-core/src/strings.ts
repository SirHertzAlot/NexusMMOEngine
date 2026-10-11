/**
 * EA25 localization string tables. The implementation (ICU subset, `t()`,
 * the pseudo-locale, validation) lives in @mmo-engine/scene so the browser
 * client and the editor use the same code; this is the server's entry to it.
 */
export { loadStrings, t, pseudoLocalize, type Strings } from "@mmo-engine/scene";
