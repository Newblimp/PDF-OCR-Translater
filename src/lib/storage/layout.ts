/** Arrangement of the result tabs (split views), persisted in localStorage. */
import { parseDock, type DockNode } from "../util/dock";

const STORAGE_KEY = "pdf-ocr-translater.result-layout.v1";

/** The saved layout, repaired to hold exactly `tabs`; null when there is none (or it is unreadable). */
export function loadDockLayout<T extends string>(tabs: readonly T[]): DockNode<T> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? parseDock(JSON.parse(raw), tabs) : null;
  } catch {
    return null;
  }
}

export function saveDockLayout(layout: DockNode<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage may be unavailable (private mode); the layout then lives in memory only.
  }
}
