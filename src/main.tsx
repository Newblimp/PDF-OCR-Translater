import { render } from "preact";
import { App } from "./app/App";
import { initialState, reducer, RESULT_TABS } from "./app/store";
import { perProvider } from "./lib/llm/registry";
import { loadApiKey } from "./lib/storage/apiKeys";
import { loadDockLayout } from "./lib/storage/layout";
import { loadSettings } from "./lib/storage/settings";
import { applyTheme } from "./lib/storage/theme";
import { createStore } from "./lib/util/createStore";
import "./styles/global.css";

const settings = loadSettings();
// Apply the saved theme before the first paint to avoid a flash.
applyTheme(settings.theme);

// The app's state, from what this browser saved: keys, settings, the arrangement of the result tabs.
const store = createStore(reducer, initialState(perProvider(loadApiKey), settings, loadDockLayout(RESULT_TABS) ?? undefined));

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root element");
render(<App store={store} />, root);
