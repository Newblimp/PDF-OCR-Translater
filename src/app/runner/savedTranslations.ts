/** Translations saved in this browser ("Recent translations"): saving, listing, reopening, deleting. */
import {
  clearSavedTranslations,
  deleteSavedTranslation,
  getSavedTranslation,
  HISTORY_VERSION,
  listSavedTranslations,
  putSavedTranslation,
} from "@/lib/storage/history";
import { getCachedOcr } from "@/lib/storage/ocrCache";
import { restoredTranslation, type TranslationState } from "../store";
import { cachedOcrState, releaseDocument } from "./document";
import type { Runtime } from "./runtime";

export async function refreshHistory(rt: Runtime): Promise<void> {
  rt.dispatch({ type: "history/set", history: await listSavedTranslations() });
}

/** Reopen a saved translation (with its OCR result when the OCR cache still has it). */
export async function openSavedTranslation(rt: Runtime, id: string): Promise<void> {
  if (rt.getState().job) return;
  const request = ++rt.session.openRequest;
  const docBefore = rt.getState().doc?.id;
  // A document loaded or another entry opened while IndexedDB was read is the user's latest action: keep it.
  const superseded = () => request !== rt.session.openRequest || rt.getState().doc?.id !== docBefore || !!rt.getState().job;
  const saved = await getSavedTranslation<TranslationState>(id);
  if (superseded()) return;
  if (!saved) {
    rt.dispatch({ type: "error/set", error: { title: "Saved translation not found", message: "It may have been removed in another tab." } });
    await refreshHistory(rt);
    return;
  }
  const cached = saved.ocrKey ? await getCachedOcr(saved.ocrKey) : null;
  const ocr = cached && saved.ocrKey ? cachedOcrState(cached, `saved:${saved.id}`, "", saved.ocrKey) : null;
  if (superseded()) return;
  releaseDocument(rt);
  const textSource = saved.sourceKind === "pasted" || saved.sourceKind === "text";
  rt.dispatch({ type: "history/open", ocr, translation: restoredTranslation(saved.translation), pastedText: textSource ? saved.translation.sourceText : null });
}

export async function deleteSaved(rt: Runtime, id: string): Promise<void> {
  rt.session.deletedIds.add(id);
  await deleteSavedTranslation(id);
  await refreshHistory(rt);
}

export async function clearHistory(rt: Runtime): Promise<void> {
  for (const entry of rt.getState().history) rt.session.deletedIds.add(entry.id);
  const current = rt.getState().translation?.id;
  if (current) rt.session.deletedIds.add(current);
  await clearSavedTranslations();
  await refreshHistory(rt);
}

export async function saveTranslation(rt: Runtime): Promise<void> {
  const { translation, settings } = rt.getState();
  if (!translation || !settings.saveTranslations || rt.session.deletedIds.has(translation.id)) return;
  await putSavedTranslation({
    id: translation.id,
    version: HISTORY_VERSION,
    createdAt: translation.completedAt,
    sourceName: translation.sourceName,
    sourceKind: translation.sourceKind,
    sourceHash: translation.sourceHash,
    ocrKey: translation.ocrKey,
    targetLanguage: translation.targetLanguage,
    provider: translation.provider,
    model: translation.model,
    translation: { ...translation, restored: false },
  });
  await refreshHistory(rt);
}
