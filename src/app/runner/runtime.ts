/** What the runner works with: the app's store (`main.tsx` creates it), read and changed by every operation. */
import type { Action, AppState } from "../store";

export interface Runtime {
  getState(): AppState;
  dispatch(action: Action): void;
}
