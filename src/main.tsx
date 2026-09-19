import { render } from "preact";
import { App } from "./app/App";
import { loadSettings } from "./lib/storage/settings";
import { applyTheme } from "./lib/storage/theme";
import "./styles/global.css";

// Apply the saved theme before the first paint to avoid a flash.
applyTheme(loadSettings().theme);

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root element");
render(<App />, root);
