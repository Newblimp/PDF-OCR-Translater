import { useEffect, useMemo, useReducer, useRef } from "preact/hooks";
import { loadApiKey } from "@/lib/storage/apiKey";
import { loadSettings } from "@/lib/storage/settings";
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
import { cancelJob, clearDocument, forgetApiKey, loadDocument, runJob, updateSettings, verifyAndSaveApiKey, type Runtime } from "./runner";
import { canRunOcr, initialState, reducer, selectSourceText, type AppState } from "./store";

export function App() {
  const [state, dispatch] = useReducer(reducer, null, () => initialState(loadApiKey(), loadSettings()));

  // A stable runtime object lets async operations read the latest state.
  const stateRef = useRef<AppState>(state);
  stateRef.current = state;
  const rt = useMemo<Runtime>(() => ({ getState: () => stateRef.current, dispatch }), [dispatch]);

  // Verify a cached key in the background on first load (also fetches the model list).
  useEffect(() => {
    const key = stateRef.current.apiKey;
    if (key) void verifyAndSaveApiKey(rt, key);
  }, [rt]);

  const sourceText = selectSourceText(state);
  const ocrPossible = canRunOcr(state);

  return (
    <div class="app">
      <Header
        keyStatus={state.keyStatus}
        apiKey={state.apiKey}
        onChangeKey={() => dispatch({ type: "key/dialog", open: true })}
        onForgetKey={() => forgetApiKey(rt)}
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
          status={state.keyStatus}
          canClose={!!state.apiKey}
          errorMessage={state.keyError}
          onSubmit={(key) => verifyAndSaveApiKey(rt, key)}
          onClose={() => dispatch({ type: "key/dialog", open: false })}
        />
      )}
    </div>
  );
}
