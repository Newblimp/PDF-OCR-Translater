import { describe, expect, it } from "vitest";
import { createStore } from "./createStore";

describe("createStore", () => {
  it("applies each action once, shows it to getState() at once, and tells subscribers only about changes", () => {
    let calls = 0;
    const store = createStore(
      (state: { n: number }, action: "inc" | "same") => {
        calls++;
        return action === "inc" ? { n: state.n + 1 } : state;
      },
      { n: 0 },
    );
    const seen: number[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getState().n));
    const before = store.getState();
    store.dispatch("inc");
    expect(store.getState().n).toBe(1);
    store.dispatch("same");
    expect(calls).toBe(2);
    expect(seen).toEqual([1]);
    expect(store.getState()).not.toBe(before);
    unsubscribe();
    store.dispatch("inc");
    expect(seen).toEqual([1]);
  });
});
