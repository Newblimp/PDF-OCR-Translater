import { useCallback, useEffect, useMemo, useReducer, useRef } from "preact/hooks";
import { loadApiKey } from "@/lib/storage/apiKeys";
import { loadSettings, type Settings, type ThemeSetting } from "@/lib/storage/settings";
import type { ProviderId } from "@/lib/llm/provider";
import { perProvider, PROVIDER_IDS } from "@/lib/llm/registry";
import { estimateRun, formatUsd, TOKENS_PER_PAGE_GUESS } from "@/lib/pipeline/estimate";
import { parsePageSelection } from "@/lib/util/pageSelection";
import { estimateTokens, formatNumber } from "@/lib/util/text";
import { ActionBar } from "@/components/ActionBar";
import { ApiKeyDialog } from "@/components/ApiKeyDialog";
import { DocumentCard } from "@/components/DocumentCard";
import { DropZone } from "@/components/DropZone";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Header } from "@/components/Header";
import { HistoryPanel } from "@/components/HistoryPanel";
import { JobStatus } from "@/components/JobStatus";
import { PasteBox } from "@/components/PasteBox";
import { ResultsPanel, type ResultActions } from "@/components/ResultsPanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import {
  cancelJob,
  clearDocument,
  clearHistory,
  deleteSaved,
  ensureOriginalStructure,
  forgetApiKeys,
  loadDocument,
  openSavedTranslation,
  refreshHistory,
  retryFailed,
  runJob,
  setPageSelection,
  submitApiKeys,
  updateSettings,
  verifyAndSaveApiKey,
  type Runtime,
} from "./runner";
import { canRunOcr, initialState, missingKeys, reducer, requiredProviders, selectSourceText, type Action, type AppState, type ResultTab } from "./store";

export function App() {
  const [state, dispatchRaw] = useReducer(reducer, null, () => initialState(perProvider((id) => loadApiKey(id)), loadSettings()));

  // A stable runtime object lets async operations read the latest state.
  // The reducer is pure, so we mirror it synchronously: `getState()` reflects
  // an action immediately, not only after Preact's deferred re-render.
  const stateRef = useRef<AppState>(state);
  stateRef.current = state;
  const dispatch = useCallback(
    (action: Action) => {
      stateRef.current = reducer(stateRef.current, action);
      dispatchRaw(action);
    },
    [dispatchRaw],
  );
  const rt = useMemo<Runtime>(() => ({ getState: () => stateRef.current, dispatch }), [dispatch]);

  // Handlers are created once, so memoised components skip the re-renders of
  // a streaming translation (about ten state updates per second).
  const on = useMemo(
    () => ({
      openKeys: () => dispatch({ type: "key/dialog", open: true }),
      closeKeys: () => dispatch({ type: "key/dialog", open: false }),
      forgetKeys: () => forgetApiKeys(rt),
      submitKeys: (keys: Partial<Record<ProviderId, string>>) => submitApiKeys(rt, keys),
      setProvider: (provider: ProviderId) => updateSettings(rt, { provider }),
      setRememberKeys: (rememberKeys: boolean) => updateSettings(rt, { rememberKeys }),
      setTheme: (theme: ThemeSetting) => updateSettings(rt, { theme }),
      changeSettings: (patch: Partial<Settings>) => updateSettings(rt, patch),
      toggleSettings: (open: boolean) => dispatch({ type: "settings/toggle", open }),
      loadFile: (file: File) => void loadDocument(rt, file),
      removeDocument: () => clearDocument(rt),
      setPageSelection: (text: string) => setPageSelection(rt, text),
      openPaste: () => dispatch({ type: "paste/mode", enabled: true }),
      closePaste: () => dispatch({ type: "paste/mode", enabled: false }),
      pasteText: (text: string) => dispatch({ type: "paste/text", text }),
      run: (kind: "ocr" | "translate" | "both") => void runJob(rt, kind),
      cancel: () => cancelJob(rt),
      dismissError: () => dispatch({ type: "error/set", error: null }),
      openSaved: (id: string) => void openSavedTranslation(rt, id),
      deleteSaved: (id: string) => void deleteSaved(rt, id),
      clearHistory: () => void clearHistory(rt),
    }),
    [rt, dispatch],
  );
  const results = useMemo<ResultActions>(
    () => ({
      setTab: (tab: ResultTab) => dispatch({ type: "tab/set", tab }),
      setShowTranslation: (show: boolean) => {
        dispatch({ type: "view/translation", show });
        // The original-language structure is produced when it is first asked for.
        if (!show) void ensureOriginalStructure(rt);
      },
      produceOriginal: () => void ensureOriginalStructure(rt),
      retry: (what: "bboxes" | "blocks") => void retryFailed(rt, what),
      useSchema: (schemaText: string) => {
        updateSettings(rt, { schemaMode: { kind: "custom", schemaText } });
        dispatch({ type: "settings/toggle", open: true });
      },
    }),
    [rt, dispatch],
  );

  // Verify cached keys in the background on first load (also fetches the model lists), and list saved translations.
  useEffect(() => {
    for (const provider of PROVIDER_IDS) {
      const key = stateRef.current.keys[provider].value;
      if (key) void verifyAndSaveApiKey(rt, provider, key);
    }
    void refreshHistory(rt);
  }, [rt]);

  const sourceText = selectSourceText(state);
  const ocrPossible = canRunOcr(state);
  const estimate = useMemo(
    () => estimateLabel(state, sourceText?.text ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed only when an input to the estimate changes
    [sourceText?.text, state.doc?.pageCount, state.doc?.pageSelection, state.doc?.kind, state.ocr, state.settings],
  );
  const busy = !!state.job;

  return (
    <div class="app">
      <Header keys={state.keys} activeProvider={state.settings.provider} theme={state.settings.theme} onChangeKeys={on.openKeys} onForgetKeys={on.forgetKeys} onTheme={on.setTheme} />

      <main class="layout">
        <section class="pane pane-input" aria-label="Input">
          {state.doc && !state.pasteMode ? (
            <DocumentCard doc={state.doc} ocr={state.ocr} busy={busy} onPageSelection={on.setPageSelection} onReplace={on.loadFile} onRemove={on.removeDocument} />
          ) : state.pasteMode ? (
            <PasteBox text={state.pastedText} onChange={on.pasteText} onClose={on.closePaste} />
          ) : (
            <DropZone onFile={on.loadFile} onPaste={on.openPaste} />
          )}

          <ActionBar
            running={state.job?.kind ?? null}
            canOcr={ocrPossible}
            canTranslate={!busy && !!sourceText}
            translateSource={sourceText?.origin ?? null}
            hasDocument={!!state.doc || state.pasteMode}
            estimate={estimate}
            onRun={on.run}
            onCancel={on.cancel}
          />

          {state.job && <JobStatus job={state.job} />}
          {state.error && <ErrorBanner error={state.error} onDismiss={on.dismissError} />}

          <SettingsPanel settings={state.settings} models={state.models} open={state.settingsOpen} onToggle={on.toggleSettings} onChange={on.changeSettings} />
          <HistoryPanel history={state.history} busy={busy} currentId={state.translation?.id ?? null} onOpen={on.openSaved} onDelete={on.deleteSaved} onClear={on.clearHistory} />
        </section>

        <section class="pane pane-results" aria-label="Results">
          <ResultsPanel state={state} actions={results} />
        </section>
      </main>

      {state.keyDialogOpen && (
        <ApiKeyDialog
          keys={state.keys}
          provider={state.settings.provider}
          required={requiredProviders(state.settings)}
          canClose={missingKeys(state).length === 0}
          remember={state.settings.rememberKeys}
          onRemember={on.setRememberKeys}
          onProvider={on.setProvider}
          onSubmit={on.submitKeys}
          onClose={on.closeKeys}
        />
      )}
    </div>
  );
}

/** "≈ 25k input + 18k output tokens over 6 calls ≈ $0.012" for the translation the action bar would start. */
function estimateLabel(state: AppState, sourceText: string | null): string | null {
  const { settings, doc, ocr } = state;
  let sourceTokens: number;
  let assumed = false;
  if (sourceText) {
    sourceTokens = estimateTokens(sourceText);
  } else if (doc && (doc.kind === "pdf" || doc.kind === "image") && doc.pageCount) {
    const selection = parsePageSelection(doc.pageSelection, doc.pageCount);
    sourceTokens = (selection.pages?.length ?? doc.pageCount) * TOKENS_PER_PAGE_GUESS;
    assumed = true;
  } else {
    return null;
  }
  const fromOcr = !!ocr && (!doc || ocr.docId === doc.id) && !state.pasteMode;
  const ocrable = !!doc && (doc.kind === "pdf" || doc.kind === "image") && !state.pasteMode;
  const model = settings.chatModels[settings.provider];
  const result = estimateRun({
    sourceTokens,
    boxes: fromOcr ? ocr.text.bboxes.filter((b) => b.dataUrl).length : 0,
    hasBlocks: fromOcr || ocrable,
    model,
    inferSchema: settings.schemaMode.kind === "infer",
    sendImages: settings.sendImages,
    bboxAnnotations: settings.bboxAnnotations,
    maxBboxAnnotations: settings.maxBboxAnnotations,
    blockTranslations: settings.blockTranslations,
    structureOriginalAlways: settings.structureOriginal === "always",
  });
  const tokens = `≈ ${formatNumber(Math.round(result.inputTokens / 100) * 100)} input + ${formatNumber(Math.round(result.outputTokens / 100) * 100)} output tokens over ${result.calls} call(s)`;
  const cost = result.cost !== null ? ` ≈ ${formatUsd(result.cost)} with ${model}` : ` with ${model} (price not known to the app)`;
  const notes = [assumed ? `assuming ~${TOKENS_PER_PAGE_GUESS} tokens per page until OCR has run` : "", ocrable && !fromOcr ? "Mistral bills OCR per page on top" : ""].filter(Boolean);
  return `Translation estimate: ${tokens}${cost}${notes.length ? ` (${notes.join("; ")})` : ""}. Rough figure: thinking and the actual translation length vary.`;
}
