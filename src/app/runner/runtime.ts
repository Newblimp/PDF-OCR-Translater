/** What the runner works with: the app's store, and what it remembers beside it for as long as the page is open. */
import type { ProviderId } from "@/lib/llm/provider";
import type { Action, AppState } from "../store";

export interface Runtime {
  getState(): AppState;
  dispatch(action: Action): void;
  /** What the runner keeps outside the store: never rendered, never saved, and one per runtime (so tests do not share it). */
  readonly session: Session;
}

export interface Session {
  /** In-flight key verifications, one per provider; a newer request cancels the older one. */
  readonly verifications: Map<ProviderId, AbortController>;
  /** Number of the latest "Open" of a saved translation; an older one that finishes reading later gives way. */
  openRequest: number;
  /** Saved translations the user deleted: a later job on the same result on screen must not write them back. */
  readonly deletedIds: Set<string>;
  /** Translations whose original-language structure was already requested or settled (it is not requested again automatically). */
  readonly originalRequested: Set<string>;
  /** Runs the job that failed last again, as it was (the error's "Retry"); null when there is none to retry. */
  retry: (() => Promise<void>) | null;
}

/** The runtime of a store (`main.tsx` makes the app's; a test makes one per case), with a fresh session. */
export function createRuntime(store: Pick<Runtime, "getState" | "dispatch">): Runtime {
  return {
    getState: store.getState,
    dispatch: store.dispatch,
    session: { verifications: new Map(), openRequest: 0, deletedIds: new Set(), originalRequested: new Set(), retry: null },
  };
}
