/**
 * A minimal external store: one state, changed only by dispatching actions
 * through a pure reducer, which runs once per action. Side-effect code reads
 * the same state the view renders, and sees an action's result as soon as it
 * is dispatched; the view subscribes (`useSyncExternalStore`).
 */
export interface Store<S, A> {
  getState(): S;
  dispatch(action: A): void;
  /** Called after every action that changed the state; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export function createStore<S, A>(reducer: (state: S, action: A) => S, initial: S): Store<S, A> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch: (action) => {
      const next = reducer(state, action);
      if (next === state) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
