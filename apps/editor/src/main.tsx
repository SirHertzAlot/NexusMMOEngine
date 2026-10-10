import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initI18n } from "@mmo-engine/client/debug";
import { getStrings } from "./strings-client.js";
import { App } from "./ui/App.js";
import "./app.css";

// The client's `t()` (the play debugger's key legend reads through it) gets the English table.
getStrings().then((b) => initI18n(b.tables), () => undefined);

const root = document.getElementById("root");
if (!root) throw new Error("editor: #root element missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
