import { memo } from "preact/compat";
import type { SavedTranslationSummary } from "@/lib/storage/history";
import { PROVIDERS } from "@/lib/llm/registry";
import type { ProviderId } from "@/lib/llm/provider";

interface Props {
  history: SavedTranslationSummary[];
  busy: boolean;
  /** Id of the translation on screen, marked in the list. */
  currentId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
}

const KIND_LABEL = { pdf: "PDF", image: "Image", text: "Text file", pasted: "Pasted text" } as const;

function providerLabel(id: string): string {
  return id in PROVIDERS ? PROVIDERS[id as ProviderId].shortLabel : id;
}

/** Translations kept in this browser (IndexedDB), newest first. */
export const HistoryPanel = memo(function HistoryPanel({ history, busy, currentId, onOpen, onDelete, onClear }: Props) {
  if (!history.length) return null;
  return (
    <details class="card history">
      <summary>
        <span>Recent translations</span>
        <span class="muted small">{history.length} saved in this browser</span>
      </summary>
      <ul class="history-list">
        {history.map((entry) => (
          <li key={entry.id} class={`history-item${entry.id === currentId ? " history-item-current" : ""}`}>
            <div class="history-text">
              <span class="history-name" title={entry.sourceName}>
                {entry.sourceName}
              </span>
              <span class="muted small">
                {KIND_LABEL[entry.sourceKind]} · → {entry.targetLanguage} · {providerLabel(entry.provider)} {entry.model} ·{" "}
                {new Date(entry.createdAt).toLocaleString()}
              </span>
            </div>
            <div class="btn-row">
              <button type="button" class="btn btn-ghost small" disabled={busy || entry.id === currentId} onClick={() => onOpen(entry.id)}>
                Open
              </button>
              <button type="button" class="btn btn-ghost small" disabled={busy} aria-label={`Delete ${entry.sourceName}`} onClick={() => onDelete(entry.id)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div class="btn-row">
        <button type="button" class="btn btn-ghost small" disabled={busy} onClick={onClear}>
          Delete all saved translations
        </button>
      </div>
    </details>
  );
});
