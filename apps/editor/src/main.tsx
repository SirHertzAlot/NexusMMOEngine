import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App.js";
import "./app.css";

const root = document.getElementById("root");
if (!root) throw new Error("editor: #root element missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
