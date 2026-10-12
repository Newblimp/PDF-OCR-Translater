/**
 * Dockable tabs, arranged like VS Code's editor groups: a tree of splits
 * whose leaves are tab groups. Every tab lives in exactly one group, and a
 * group shows one tab at a time. Pure functions (the reducer applies them),
 * plus the geometry the dock component draws from.
 */

export type SplitDirection = "row" | "column";
export type DockSide = "left" | "right" | "top" | "bottom";

export interface DockGroup<T extends string> {
  kind: "group";
  id: string;
  tabs: T[];
  active: T;
}

export interface DockSplit<T extends string> {
  kind: "split";
  id: string;
  /** "row": children side by side; "column": stacked. */
  direction: SplitDirection;
  children: Array<DockNode<T>>;
  /** Relative size of each child (only the ratios matter). */
  sizes: number[];
}

export type DockNode<T extends string> = DockGroup<T> | DockSplit<T>;

/**
 * Where a dragged tab goes: into a group's tab bar before `index`, into a
 * group ("center": last tab), or into a new group on one side of a group.
 */
export type DockTarget = { group: string; index: number } | { group: string; side: DockSide | "center" };

export function singleGroup<T extends string>(tabs: readonly [T, ...T[]]): DockGroup<T> {
  return { kind: "group", id: "g1", tabs: [...tabs], active: tabs[0] };
}

/** Groups in reading order (left to right, top to bottom). */
export function dockGroups<T extends string>(node: DockNode<T>): Array<DockGroup<T>> {
  return node.kind === "group" ? [node] : node.children.flatMap((c) => dockGroups(c));
}

export function groupOf<T extends string>(node: DockNode<T>, tab: T): DockGroup<T> | undefined {
  return dockGroups(node).find((g) => g.tabs.includes(tab));
}

function findGroup<T extends string>(node: DockNode<T>, id: string): DockGroup<T> | undefined {
  return dockGroups(node).find((g) => g.id === id);
}

function mapNodes<T extends string>(node: DockNode<T>, fn: (n: DockNode<T>) => DockNode<T>): DockNode<T> {
  const mapped = fn(node);
  if (mapped !== node || node.kind === "group") return mapped;
  const children = node.children.map((c) => mapNodes(c, fn));
  return children.every((c, i) => c === node.children[i]) ? node : { ...node, children };
}

/** Next free id with this prefix ("g" for groups, "s" for splits). */
function nextId(root: DockNode<string>, prefix: "g" | "s"): string {
  let max = 0;
  const visit = (n: DockNode<string>) => {
    if (n.id.startsWith(prefix)) max = Math.max(max, Number(n.id.slice(1)) || 0);
    if (n.kind === "split") n.children.forEach(visit);
  };
  visit(root);
  return `${prefix}${max + 1}`;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/**
 * Drops empty groups, replaces splits left with one child by that child and
 * merges a split into its parent when both run in the same direction.
 * Sizes are rescaled so each split's add up to its number of children.
 */
function prune<T extends string>(node: DockNode<T>): DockNode<T> | null {
  if (node.kind === "group") return node.tabs.length ? node : null;
  const children: Array<DockNode<T>> = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const kept = prune(child);
    if (!kept) return;
    const weight = node.sizes[i] ?? 1;
    if (kept.kind === "split" && kept.direction === node.direction) {
      const total = sum(kept.sizes) || 1;
      kept.children.forEach((c, j) => {
        children.push(c);
        sizes.push((weight * (kept.sizes[j] ?? 1)) / total);
      });
    } else {
      children.push(kept);
      sizes.push(weight);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  const total = sum(sizes) || 1;
  return { ...node, children, sizes: sizes.map((s) => (s * children.length) / total) };
}

/** Shows `tab` in its group. */
export function activateTab<T extends string>(root: DockNode<T>, tab: T): DockNode<T> {
  const group = groupOf(root, tab);
  if (!group || group.active === tab) return root;
  return mapNodes(root, (n) => (n === group ? { ...group, active: tab } : n));
}

export function resizeSplit<T extends string>(root: DockNode<T>, id: string, sizes: number[]): DockNode<T> {
  return mapNodes(root, (n) =>
    n.kind === "split" && n.id === id && sizes.length === n.children.length && sizes.every((s) => Number.isFinite(s) && s > 0)
      ? { ...n, sizes: [...sizes] }
      : n,
  );
}

/** Whether dropping `tab` on `target` would leave the layout as it is. */
export function isMoveNoop<T extends string>(root: DockNode<T>, tab: T, target: DockTarget): boolean {
  const source = groupOf(root, tab);
  const dest = findGroup(root, target.group);
  if (!source || !dest) return true;
  if (source !== dest) return false;
  if ("side" in target) return target.side === "center" || source.tabs.length === 1;
  const from = source.tabs.indexOf(tab);
  return target.index === from || target.index === from + 1;
}

/** Moves `tab` to `target` and shows it there; the group it leaves closes when it is left empty. */
export function moveTab<T extends string>(root: DockNode<T>, tab: T, target: DockTarget): DockNode<T> {
  if (isMoveNoop(root, tab, target)) return root;
  const source = groupOf(root, tab)!;
  const dest = findGroup(root, target.group)!;

  if ("index" in target || target.side === "center") {
    const tabs = dest.tabs.filter((t) => t !== tab);
    let index = "index" in target ? Math.max(0, Math.min(target.index, dest.tabs.length)) : tabs.length;
    if (source === dest && dest.tabs.indexOf(tab) < index) index--; // the tab itself was before the drop position
    tabs.splice(index, 0, tab);
    const moved = mapNodes(root, (n) => (n === dest ? { ...dest, tabs, active: tab } : n === source ? withoutTab(source, tab) : n));
    return prune(moved) ?? root;
  }

  const side = target.side;
  const direction: SplitDirection = side === "left" || side === "right" ? "row" : "column";
  const before = side === "left" || side === "top";
  const fresh: DockGroup<T> = { kind: "group", id: nextId(root, "g"), tabs: [tab], active: tab };
  const splitId = nextId(root, "s");
  // Take the tab out first (the group stays in place, possibly empty, until the prune).
  const emptied = source === dest ? withoutTab(source, tab) : null;
  const without = mapNodes(root, (n) => (n === source ? (emptied ?? withoutTab(source, tab)) : n));
  const destNow = emptied ?? dest;
  const placed = mapNodes(without, (n) => {
    // Beside the group in a split that already runs in this direction: share its space.
    if (n.kind === "split" && n.direction === direction) {
      const at = n.children.indexOf(destNow);
      if (at < 0) return n;
      const half = (n.sizes[at] ?? 1) / 2;
      const children = [...n.children];
      const sizes = [...n.sizes];
      children.splice(before ? at : at + 1, 0, fresh);
      sizes.splice(at, 1, half, half);
      return { ...n, children, sizes };
    }
    if (n === destNow) {
      return { kind: "split", id: splitId, direction, children: before ? [fresh, destNow] : [destNow, fresh], sizes: [1, 1] };
    }
    return n;
  });
  return prune(placed) ?? root;
}

function withoutTab<T extends string>(group: DockGroup<T>, tab: T): DockGroup<T> {
  const at = group.tabs.indexOf(tab);
  const tabs = group.tabs.filter((t) => t !== tab);
  const active = group.active === tab ? (tabs[Math.min(at, tabs.length - 1)] ?? group.active) : group.active;
  return { ...group, tabs, active };
}

/** Same groups, tabs and splits (ignoring ids, sizes and which tab is shown). */
export function sameArrangement<T extends string>(a: DockNode<T>, b: DockNode<T>): boolean {
  if (a.kind === "group" || b.kind === "group") {
    return a.kind === "group" && b.kind === "group" && a.tabs.length === b.tabs.length && a.tabs.every((t, i) => t === b.tabs[i]);
  }
  return a.direction === b.direction && a.children.length === b.children.length && a.children.every((c, i) => sameArrangement(c, b.children[i]!));
}

/**
 * Reads a layout saved earlier, repairing what no longer fits: unknown or
 * repeated tabs are dropped, missing ones join the first group, ids are
 * reassigned. Null when nothing usable is left.
 */
export function parseDock<T extends string>(raw: unknown, tabs: readonly T[]): DockNode<T> | null {
  const known = new Set<string>(tabs);
  const seen = new Set<T>();
  let groups = 0;
  let splits = 0;
  const walk = (value: unknown, depth: number): DockNode<T> | null => {
    if (typeof value !== "object" || value === null || depth > 12) return null;
    const v = value as Record<string, unknown>;
    if (v["kind"] === "group" && Array.isArray(v["tabs"])) {
      const list: T[] = [];
      for (const t of v["tabs"]) {
        if (typeof t === "string" && known.has(t) && !seen.has(t as T)) {
          seen.add(t as T);
          list.push(t as T);
        }
      }
      if (!list[0]) return null;
      const active = list.includes(v["active"] as T) ? (v["active"] as T) : list[0];
      return { kind: "group", id: `g${++groups}`, tabs: list, active };
    }
    if (v["kind"] === "split" && (v["direction"] === "row" || v["direction"] === "column") && Array.isArray(v["children"])) {
      const savedSizes = Array.isArray(v["sizes"]) ? (v["sizes"] as unknown[]) : [];
      const children: Array<DockNode<T>> = [];
      const sizes: number[] = [];
      v["children"].forEach((c, i) => {
        const child = walk(c, depth + 1);
        if (!child) return;
        const size = savedSizes[i];
        children.push(child);
        sizes.push(typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 1);
      });
      return { kind: "split", id: `s${++splits}`, direction: v["direction"], children, sizes };
    }
    return null;
  };
  let root = walk(raw, 0);
  const missing = tabs.filter((t) => !seen.has(t));
  if (missing.length) {
    const first = root ? dockGroups(root)[0] : undefined;
    if (root && first) root = mapNodes(root, (n) => (n === first ? { ...first, tabs: [...first.tabs, ...missing] } : n));
    else if (missing[0]) root = { kind: "group", id: `g${++groups}`, tabs: missing, active: missing[0] };
  }
  return root ? prune(root) : null;
}

/** The side of a group a drop at (x, y) — fractions of its width and height — splits off, or its centre. */
export function zoneAt(x: number, y: number, edge = 0.3): DockSide | "center" {
  const distances: Array<[DockSide, number]> = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  const [side, distance] = distances.reduce((a, b) => (b[1] < a[1] ? b : a));
  return distance < edge ? side : "center";
}

// -------------------------------------------------------------- what is shown

export interface VisibleGroup<T extends string> {
  kind: "group";
  group: DockGroup<T>;
  /** The group's tabs that can be shown, in order. */
  tabs: T[];
  /** The tab shown: the group's choice, or its first available tab. */
  active: T;
}

export interface VisibleSplit<T extends string> {
  kind: "split";
  split: DockSplit<T>;
  children: Array<VisibleNode<T>>;
  /** Index in `split.children` of each visible child (for its size). */
  indexes: number[];
}

export type VisibleNode<T extends string> = VisibleGroup<T> | VisibleSplit<T>;

/** The layout without the tabs that have nothing to show yet; groups (and splits) left empty make room for the others. */
export function visibleDock<T extends string>(node: DockNode<T>, isAvailable: (tab: T) => boolean): VisibleNode<T> | null {
  if (node.kind === "group") {
    const tabs = node.tabs.filter(isAvailable);
    if (!tabs[0]) return null;
    return { kind: "group", group: node, tabs, active: tabs.includes(node.active) ? node.active : tabs[0] };
  }
  const children: Array<VisibleNode<T>> = [];
  const indexes: number[] = [];
  node.children.forEach((child, i) => {
    const shown = visibleDock(child, isAvailable);
    if (shown) {
      children.push(shown);
      indexes.push(i);
    }
  });
  if (children.length <= 1) return children[0] ?? null;
  return { kind: "split", split: node, children, indexes };
}

// ------------------------------------------------------------------- geometry

/** A length relative to the dock: `pct`% of its width (or height) plus `px` pixels. */
export interface Lin {
  pct: number;
  px: number;
}

export interface DockRect {
  left: Lin;
  top: Lin;
  width: Lin;
  height: Lin;
}

export interface PlacedGroup<T extends string> {
  group: VisibleGroup<T>;
  rect: DockRect;
  /** Position in reading order. */
  order: number;
}

/** The handle between two neighbouring children of a split. */
export interface PlacedSplitter<T extends string> {
  split: DockSplit<T>;
  /** Indexes in `split.children` of the children before and after the handle. */
  before: number;
  after: number;
  rect: DockRect;
  beforeSize: Lin;
  afterSize: Lin;
}

const add = (a: Lin, b: Lin): Lin => ({ pct: a.pct + b.pct, px: a.px + b.px });
const scale = (a: Lin, k: number): Lin => ({ pct: a.pct * k, px: a.px * k });
const px = (n: number): Lin => ({ pct: 0, px: n });

/** Pixels of `l` in a dock `total` pixels wide (or high). */
export function linPx(l: Lin, total: number): number {
  return (l.pct / 100) * total + l.px;
}

export function linCss(l: Lin): string {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return `calc(${round(l.pct)}% + ${round(l.px)}px)`;
}

/**
 * Where each group and splitter sits, as lengths relative to the dock, with
 * `gap` pixels between neighbours. Lengths rather than pixels, so the layout
 * follows the dock's size without measuring it.
 */
export function dockGeometry<T extends string>(root: VisibleNode<T>, gap: number): { groups: Array<PlacedGroup<T>>; splitters: Array<PlacedSplitter<T>> } {
  const groups: Array<PlacedGroup<T>> = [];
  const splitters: Array<PlacedSplitter<T>> = [];
  const place = (node: VisibleNode<T>, rect: DockRect) => {
    if (node.kind === "group") {
      groups.push({ group: node, rect, order: groups.length });
      return;
    }
    const row = node.split.direction === "row";
    const start = row ? "left" : "top";
    const extent = row ? "width" : "height";
    const available = add(rect[extent], px(-(node.children.length - 1) * gap));
    const weights = node.indexes.map((i) => node.split.sizes[i] ?? 1);
    const total = sum(weights) || 1;
    const sizes = weights.map((w) => scale(available, w / total));
    let offset = rect[start];
    node.children.forEach((child, i) => {
      const size = sizes[i]!;
      place(child, { ...rect, [start]: offset, [extent]: size });
      offset = add(offset, size);
      if (i < node.children.length - 1) {
        splitters.push({
          split: node.split,
          before: node.indexes[i]!,
          after: node.indexes[i + 1]!,
          rect: { ...rect, [start]: offset, [extent]: px(gap) },
          beforeSize: size,
          afterSize: sizes[i + 1]!,
        });
        offset = add(offset, px(gap));
      }
    });
  };
  place(root, { left: px(0), top: px(0), width: { pct: 100, px: 0 }, height: { pct: 100, px: 0 } });
  return { groups, splitters };
}

/**
 * New sizes of a split after its handle between `before` and `after` moved
 * by `delta` pixels, keeping both children at least `minPx` (or half their
 * room, when there is less).
 */
export function shiftSizes(sizes: number[], before: number, after: number, beforePx: number, afterPx: number, delta: number, minPx: number): number[] {
  const room = beforePx + afterPx;
  const a = sizes[before];
  const b = sizes[after];
  if (room <= 0 || a === undefined || b === undefined) return sizes;
  const min = Math.min(minPx, room / 2);
  const next = Math.max(min, Math.min(room - min, beforePx + delta));
  const out = [...sizes];
  out[before] = ((a + b) * next) / room;
  out[after] = a + b - out[before]!;
  return out;
}
