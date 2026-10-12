import { useCallback, useEffect, useMemo, useReducer, useRef } from "preact/hooks";
import { loadApiKey } from "@/lib/storage/apiKeys";
import { loadDockLayout, saveDockLayout } from "@/lib/storage/layout";
import { loadSettings, type Settings, type ThemeSetting } from "@/lib/storage/settings";
import type { ProviderId } from "@/lib/llm/provider";
import type { DockTarget } from "@/lib/util/dock";
import { perProvider, PROVIDER_IDS } from "@/lib/llm/registry";
import type { OcrCleanPage } from "@/lib/pipeline/ocrText";
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
import { QuickOptions } from "@/components/QuickOptions";
import { SettingsPanel } from "@/components/SettingsPanel";
import { SideRail } from "@/components/SideRail";
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
import {
  canRunOcr,
  initialState,
  missingKeys,
  reducer,
  requiredProviders,
  RESULT_TABS,
  selectSourceText,
  type Action,
  type AppState,
  type ResultTab,
} from "./store";

export function App() {
  const [state, dispatchRaw] = useReducer(reducer, null, () =>
    initialState(
      perProvider((id) => loadApiKey(id)),
      loadSettings(),
      loadDockLayout(RESULT_TABS) ?? undefined,
    ),
  );

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
      toggleSidePanel: () => updateSettings(rt, { sidePanelCollapsed: !rt.getState().settings.sidePanelCollapsed }),
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
      moveTab: (tab: ResultTab, target: DockTarget) => dispatch({ type: "layout/move", tab, target }),
      resizeSplit: (split: string, sizes: number[]) => dispatch({ type: "layout/resize", split, sizes }),
      resetLayout: () => dispatch({ type: "layout/reset" }),
      setOcrShowPdf: (ocrShowPdf: boolean) => updateSettings(rt, { ocrShowPdf }),
      setOcrLinkScroll: (ocrLinkScroll: boolean) => updateSettings(rt, { ocrLinkScroll }),
      setOcrHiddenTypes: (ocrHiddenTypes: string[]) => updateSettings(rt, { ocrHiddenTypes }),
      setOcrMatchLayout: (ocrMatchLayout: boolean) => updateSettings(rt, { ocrMatchLayout }),
      setOcrPickBlocks: (ocrPickBlocks: boolean) => updateSettings(rt, { ocrPickBlocks }),
      toggleBlock: (pages: readonly OcrCleanPage[], id: string) => dispatch({ type: "blocks/toggle", pages, id }),
      includeAllBlocks: () => dispatch({ type: "blocks/includeAll" }),
      setShowTranslation: (show: boolean) => dispatch({ type: "view/translation", show }),
      requestOriginal: () => void ensureOriginalStructure(rt),
      produceOriginal: () => void ensureOriginalStructure(rt, true),
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

  // The arrangement of the result tabs is kept for the next visit.
  useEffect(() => saveDockLayout(state.resultLayout), [state.resultLayout]);

  const sourceText = selectSourceText(state);
  const ocrPossible = canRunOcr(state);
  const busy = !!state.job;
  const collapsed = state.settings.sidePanelCollapsed;

  return (
    <div class="app">
      <Header
        keys={state.keys}
        activeProvider={state.settings.provider}
        theme={state.settings.theme}
        onChangeKeys={on.openKeys}
        onForgetKeys={on.forgetKeys}
        onTheme={on.setTheme}
        sidePanelCollapsed={collapsed}
        onToggleSidePanel={on.toggleSidePanel}
      />

      <main class={`layout${collapsed ? " layout-side-collapsed" : ""}`}>
        <section id="side-panel" class="pane pane-input" aria-label="Input">
          {collapsed && <SideRail running={state.job?.kind ?? null} error={state.error} onExpand={on.toggleSidePanel} onCancel={on.cancel} />}
          {/* Folded away, not unmounted: drafts and open sections stay as they were. */}
          <div class="pane-body" hidden={collapsed}>
            {state.doc && !state.pasteMode ? (
              <DocumentCard
                doc={state.doc}
                ocr={state.ocr}
                busy={busy}
                onPageSelection={on.setPageSelection}
                onReplace={on.loadFile}
                onRemove={on.removeDocument}
              />
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
              onRun={on.run}
              onCancel={on.cancel}
            />

            {state.job && <JobStatus job={state.job} />}
            {state.error && <ErrorBanner error={state.error} onDismiss={on.dismissError} />}

            <QuickOptions targetLanguage={state.settings.targetLanguage} glossary={state.settings.glossary} onChange={on.changeSettings} />
            <SettingsPanel
              settings={state.settings}
              models={state.models}
              open={state.settingsOpen}
              onToggle={on.toggleSettings}
              onChange={on.changeSettings}
            />
            <HistoryPanel
              history={state.history}
              busy={busy}
              currentId={state.translation?.id ?? null}
              onOpen={on.openSaved}
              onDelete={on.deleteSaved}
              onClear={on.clearHistory}
            />
          </div>
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
