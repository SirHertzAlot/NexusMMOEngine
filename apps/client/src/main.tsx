import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { CharacterPreview } from "./ui/character-preview.js";
import strings from "virtual:game-strings";
import { initI18n } from "./i18n.js";
import "./app.css";

initI18n(strings, location.search, navigator.languages ?? []);

const root = document.getElementById("root");
if (!root) throw new Error("client: #root element missing");
// ?preview=character: the modular character preview (dev).
const preview = new URLSearchParams(location.search).get("preview");
createRoot(root).render(
  <StrictMode>
    {preview === "character" ? <CharacterPreview /> : <App />}
  </StrictMode>,
);
