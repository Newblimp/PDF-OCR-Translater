import { describe, expect, it } from "vitest";
import { runPool } from "./pool";

describe("runPool", () => {
  it("runs every item with bounded concurrency", async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5], 2, async (item) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(item);
      active--;
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("stops taking new items after an error and rejects with it", async () => {
    const started: number[] = [];
    const run = runPool([1, 2, 3, 4], 1, async (item) => {
      started.push(item);
      if (item === 2) throw new Error("boom");
    });
    await expect(run).rejects.toThrow("boom");
    expect(started).toEqual([1, 2]);
  });

  it("stops when asked to", async () => {
    const started: number[] = [];
    let stop = false;
    await runPool([1, 2, 3], 1, async (item) => {
      started.push(item);
      stop = true;
    }, () => stop);
    expect(started).toEqual([1]);
  });
});
