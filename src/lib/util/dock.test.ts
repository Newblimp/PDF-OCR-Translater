import { describe, expect, it } from "vitest";
import {
  activateTab,
  dockGeometry,
  dockGroups,
  isMoveNoop,
  linPx,
  moveTab,
  parseDock,
  resizeSplit,
  sameArrangement,
  shiftSizes,
  singleGroup,
  visibleDock,
  zoneAt,
  type DockNode,
} from "./dock";

type Tab = "a" | "b" | "c" | "d";
const TABS = ["a", "b", "c", "d"] as const;

/** Compact picture of a layout: groups as "[a b*]" (* = shown), splits as "row(…)" / "column(…)". */
function shape(node: DockNode<Tab>): string {
  if (node.kind === "group") return `[${node.tabs.map((t) => (t === node.active ? `${t}*` : t)).join(" ")}]`;
  return `${node.direction}(${node.children.map(shape).join(", ")})`;
}

describe("moving tabs", () => {
  const start = singleGroup(TABS);

  it("splits a tab off to any side of its group and shows it there", () => {
    expect(shape(moveTab(start, "c", { group: "g1", side: "right" }))).toBe("row([a* b d], [c*])");
    expect(shape(moveTab(start, "c", { group: "g1", side: "left" }))).toBe("row([c*], [a* b d])");
    expect(shape(moveTab(start, "a", { group: "g1", side: "top" }))).toBe("column([a*], [b* c d])");
    expect(shape(moveTab(start, "a", { group: "g1", side: "bottom" }))).toBe("column([b* c d], [a*])");
  });

  it("shares the space of the target group within a split of the same direction", () => {
    const two = moveTab(start, "c", { group: "g1", side: "right" }); // row([a b d], [c]) with sizes [1, 1]
    const three = moveTab(two, "d", { group: "g2", side: "left" });
    expect(shape(three)).toBe("row([a* b], [d*], [c*])");
    expect(three.kind === "split" && three.sizes).toEqual([1.5, 0.75, 0.75]);
  });

  it("nests a split across the direction of the parent", () => {
    const two = moveTab(start, "c", { group: "g1", side: "right" });
    expect(shape(moveTab(two, "d", { group: "g2", side: "bottom" }))).toBe("row([a* b], column([c*], [d*]))");
  });

  it("closes a group when its last tab leaves, and flattens what is left", () => {
    let layout = moveTab(start, "c", { group: "g1", side: "right" });
    layout = moveTab(layout, "d", { group: "g2", side: "bottom" }); // row([a b], column([c], [d]))
    layout = moveTab(layout, "c", { group: "g1", side: "center" });
    expect(shape(layout)).toBe("row([a b c*], [d*])");
    layout = moveTab(layout, "d", { group: "g1", index: 0 });
    expect(shape(layout)).toBe("[d* a b c]");
  });

  it("moves a group's only tab to the side of another group", () => {
    const two = moveTab(start, "c", { group: "g1", side: "right" });
    const swapped = moveTab(two, "c", { group: "g1", side: "left" });
    expect(shape(swapped)).toBe("row([c*], [a* b d])");
    expect(dockGroups(swapped).map((g) => g.id)).toEqual(["g3", "g1"]);
  });

  it("reorders tabs within a group", () => {
    expect(shape(moveTab(start, "a", { group: "g1", index: 3 }))).toBe("[b c a* d]");
    expect(shape(moveTab(start, "a", { group: "g1", index: 99 }))).toBe("[b c d a*]");
    expect(shape(moveTab(start, "d", { group: "g1", index: 1 }))).toBe("[a d* b c]");
  });

  it("recognises drops that change nothing", () => {
    const two = moveTab(start, "c", { group: "g1", side: "right" });
    expect(isMoveNoop(start, "a", { group: "g1", side: "center" })).toBe(true);
    expect(isMoveNoop(start, "b", { group: "g1", index: 1 })).toBe(true);
    expect(isMoveNoop(start, "b", { group: "g1", index: 2 })).toBe(true);
    expect(isMoveNoop(two, "c", { group: "g2", side: "left" })).toBe(true); // the only tab of its group
    expect(isMoveNoop(start, "a", { group: "nope", side: "left" })).toBe(true);
    expect(moveTab(two, "c", { group: "g2", side: "top" })).toBe(two);
  });

  it("shows the neighbour when the shown tab leaves", () => {
    const layout = activateTab(start, "b");
    expect(shape(moveTab(layout, "b", { group: "g1", side: "right" }))).toBe("row([a c* d], [b*])");
  });
});

describe("activating and resizing", () => {
  it("shows a tab in its own group and leaves the others alone", () => {
    const layout = moveTab(singleGroup(TABS), "c", { group: "g1", side: "right" });
    const next = activateTab(layout, "b");
    expect(shape(next)).toBe("row([a b* d], [c*])");
    expect(activateTab(next, "b")).toBe(next);
  });

  it("only accepts one positive size per child", () => {
    const layout = moveTab(singleGroup(TABS), "c", { group: "g1", side: "right" });
    expect(resizeSplit(layout, "s1", [3, 1])).toMatchObject({ sizes: [3, 1] });
    expect(resizeSplit(layout, "s1", [3])).toBe(layout);
    expect(resizeSplit(layout, "s1", [3, -1])).toBe(layout);
  });

  it("moves a splitter by pixels within the minimum sizes", () => {
    const close = (values: number[]) => values.map((v) => expect.closeTo(v, 9));
    expect(shiftSizes([1, 1], 0, 1, 300, 300, 100, 50)).toEqual(close([4 / 3, 2 / 3]));
    expect(shiftSizes([1, 1], 0, 1, 300, 300, -1000, 50)).toEqual(close([1 / 6, 11 / 6]));
    expect(shiftSizes([2, 1, 1], 1, 2, 100, 100, 0, 150)).toEqual([2, 1, 1]);
  });
});

describe("saved layouts", () => {
  it("round-trips and repairs what no longer fits", () => {
    const layout = moveTab(moveTab(singleGroup(TABS), "c", { group: "g1", side: "right" }), "d", { group: "g2", side: "bottom" });
    expect(sameArrangement(parseDock(JSON.parse(JSON.stringify(layout)), TABS)!, layout)).toBe(true);
    const repaired = parseDock(
      { kind: "split", direction: "row", sizes: [2, "x"], children: [{ kind: "group", tabs: ["b", "zz", "b"], active: "zz" }, { kind: "group", tabs: ["c"] }, { kind: "odd" }] },
      TABS,
    );
    expect(shape(repaired!)).toBe("row([b* a d], [c*])");
    expect(repaired!.kind === "split" && repaired!.sizes).toEqual([4 / 3, 2 / 3]);
    expect(shape(parseDock(null, TABS)!)).toBe("[a* b c d]");
    expect(shape(parseDock({ kind: "split", direction: "column", children: [{ kind: "group", tabs: ["d"] }] }, TABS)!)).toBe("[d* a b c]");
  });

  it("tells a custom arrangement from the default", () => {
    const start = singleGroup(TABS);
    expect(sameArrangement(activateTab(start, "c"), start)).toBe(true);
    expect(sameArrangement(moveTab(start, "a", { group: "g1", index: 2 }), start)).toBe(false);
    expect(sameArrangement(moveTab(start, "a", { group: "g1", side: "top" }), start)).toBe(false);
  });
});

describe("rendering", () => {
  it("hides groups without anything to show and gives their room to the others", () => {
    const layout = moveTab(moveTab(singleGroup(TABS), "c", { group: "g1", side: "right" }), "d", { group: "g2", side: "bottom" });
    const shown = visibleDock(layout, (t) => t !== "d" && t !== "a");
    expect(shown?.kind).toBe("split");
    if (shown?.kind !== "split") return;
    expect(shown.children.map((c) => (c.kind === "group" ? [c.active, ...c.tabs] : "split"))).toEqual([
      ["b", "b"],
      ["c", "c"],
    ]);
    expect(visibleDock(layout, () => false)).toBeNull();
  });

  it("places groups and splitters as lengths relative to the dock", () => {
    const layout = moveTab(moveTab(singleGroup(TABS), "c", { group: "g1", side: "right" }), "d", { group: "g2", side: "bottom" });
    const { groups, splitters } = dockGeometry(visibleDock(layout, () => true)!, 6);
    const at = (i: number, width: number, height: number) => {
      const r = groups[i]!.rect;
      return [linPx(r.left, width), linPx(r.top, height), linPx(r.width, width), linPx(r.height, height)];
    };
    expect(at(0, 1006, 606)).toEqual([0, 0, 500, 606]);
    expect(at(1, 1006, 606)).toEqual([506, 0, 500, 300]);
    expect(at(2, 1006, 606)).toEqual([506, 306, 500, 300]);
    expect(splitters.map((s) => [s.split.direction, linPx(s.rect.left, 1006), linPx(s.rect.width, 1006)])).toEqual([
      ["row", 500, 6],
      ["column", 506, 500],
    ]);
  });

  it("picks the side of a group nearest to the pointer, or its centre", () => {
    expect(zoneAt(0.1, 0.5)).toBe("left");
    expect(zoneAt(0.9, 0.4)).toBe("right");
    expect(zoneAt(0.5, 0.05)).toBe("top");
    expect(zoneAt(0.6, 0.8)).toBe("bottom");
    expect(zoneAt(0.5, 0.5)).toBe("center");
  });
});
