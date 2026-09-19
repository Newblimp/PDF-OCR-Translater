import { useEffect, useMemo, useReducer, useRef } from "preact/hooks";
import { loadApiKey } from "@/lib/storage/apiKeys";
import { loadSettings } from "@/lib/storage/settings";
import type { ProviderId } from "@/lib/llm/provider";
import { ActionBar } from "@/components/ActionBar";
import { ApiKeyDialog } from "@/components/ApiKeyDialog";
import { DocumentCard } from "@/components/DocumentCard";
import { DropZone } from "@/components/DropZone";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Header } from "@/components/Header";
import { JobStatus } from "@/components/JobStatus";
import { PasteBox } from "@/components/PasteBox";
import { ResultsPanel } from "@/components/ResultsPanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import {
  cancelJob,
  clearDocument,
  forgetApiKeys,
  loadDocument,
  runJob,
  submitApiKeys,
  updateSettings,
  verifyAndSaveApiKey,
  type Runtime,
} from "./runner";
import { canRunOcr, initialState, missingKeys, reducer, requiredProviders, selectSourceText, type AppState } from "./store";

export function App() {
  const [state, dispatch] = useReducer(reducer, null, () =>
    initialState({ mistral: loadApiKey("mistral"), openai: loadApiKey("openai") }, loadSettings()),
  );

  // A stable runtime object lets async operations read the latest state.
  const stateRef = useRef<AppState>(state);
  stateRef.current = state;
  const rt = useMemo<Runtime>(() => ({ getState: () => stateRef.current, dispatch }), [dispatch]);

  // Verify cached keys in the background on first load (also fetches the model lists).
  useEffect(() => {
    for (const provider of Object.keys(stateRef.current.keys) as ProviderId[]) {
      const key = stateRef.current.keys[provider].value;
      if (key) void verifyAndSaveApiKey(rt, provider, key);
    }
  }, [rt]);

  const sourceText = selectSourceText(state);
  const ocrPossible = canRunOcr(state);

  return (
    <div class="app">
      <Header
        keys={state.keys}
        activeProvider={state.settings.provider}
        theme={state.settings.theme}
        onChangeKeys={() => dispatch({ type: "key/dialog", open: true })}
        onForgetKeys={() => forgetApiKeys(rt)}
        onTheme={(theme) => updateSettings(rt, { theme })}
      />

      <main class="layout">
        <section class="pane pane-input" aria-label="Input">
          {state.doc && !state.pasteMode ? (
            <DocumentCard
              doc={state.doc}
              ocr={state.ocr}
              busy={!!state.job}
              onReplace={(file) => void loadDocument(rt, file)}
              onRemove={() => clearDocument(rt)}
            />
          ) : state.pasteMode ? (
            <PasteBox
              text={state.pastedText}
              onChange={(text) => dispatch({ type: "paste/text", text })}
              onClose={() => dispatch({ type: "paste/mode", enabled: false })}
            />
          ) : (
            <DropZone onFile={(file) => void loadDocument(rt, file)} onPaste={() => dispatch({ type: "paste/mode", enabled: true })} />
          )}

          <ActionBar
            running={state.job?.kind ?? null}
            canOcr={ocrPossible}
            canTranslate={!state.job && !!sourceText}
            translateSource={sourceText?.origin ?? null}
            hasDocument={!!state.doc || state.pasteMode}
            onRun={(kind) => void runJob(rt, kind)}
            onCancel={() => cancelJob(rt)}
          />

          {state.job && <JobStatus job={state.job} settings={state.settings} />}
          {state.error && <ErrorBanner error={state.error} onDismiss={() => dispatch({ type: "error/set", error: null })} />}

          <SettingsPanel
            settings={state.settings}
            models={state.models}
            open={state.settingsOpen}
            onToggle={(open) => dispatch({ type: "settings/toggle", open })}
            onChange={(patch) => updateSettings(rt, patch)}
          />
        </section>

        <section class="pane pane-results" aria-label="Results">
          <ResultsPanel
            state={state}
            onTab={(tab) => dispatch({ type: "tab/set", tab })}
            onUseSchema={(schemaText) => {
              updateSettings(rt, { schemaMode: { kind: "custom", schemaText } });
              dispatch({ type: "settings/toggle", open: true });
            }}
          />
        </section>
      </main>

      {state.keyDialogOpen && (
        <ApiKeyDialog
          keys={state.keys}
          required={requiredProviders(state.settings)}
          canClose={missingKeys(state).length === 0}
          onSubmit={(keys) => submitApiKeys(rt, keys)}
          onClose={() => dispatch({ type: "key/dialog", open: false })}
        />
      )}
    </div>
  );
}
