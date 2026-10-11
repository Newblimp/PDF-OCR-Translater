import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import {
  dockGeometry,
  isMoveNoop,
  linCss,
  linPx,
  resizeSplit,
  shiftSizes,
  visibleDock,
  zoneAt,
  type DockNode,
  type DockRect,
  type DockTarget,
  type PlacedGroup,
  type PlacedSplitter,
} from "@/lib/util/dock";
import { ResetLayoutIcon, SplitDownIcon, SplitRightIcon } from "./icons";

/** Pixels between neighbouring groups: the splitter handle. */
const GAP = 6;
/** Smallest width (side by side) or height (stacked) a splitter leaves a group. */
const MIN_SIZE = { row: 180, column: 100 } as const;
/** Pixels a splitter moves per arrow key. */
const KEY_STEP = 40;
/** Drag data type of a tab: not text, so a tab cannot be dropped into an input by mistake. */
const TAB_DRAG_TYPE = "application/x-dock-tab";

interface Props<T extends string> {
  layout: DockNode<T>;
  /** All tabs, in a fixed order: the views keep it in the DOM, so moving a tab never remounts its view. */
  tabs: readonly T[];
  labels: Record<T, string>;
  /** Tabs with something to show; the others are hidden, and groups left empty make room. */
  available: ReadonlySet<T>;
  renderTab: (tab: T) => ComponentChildren;
  /** The layout differs from the default: offer to reset it. */
  customised: boolean;
  onActivate: (tab: T) => void;
  onMove: (tab: T, target: DockTarget) => void;
  onResize: (split: string, sizes: number[]) => void;
  onReset: () => void;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where the dragged tab would land, and the outline shown there. */
interface DropPreview {
  target: DockTarget;
  box: Box;
  /** An insertion mark in a tab bar rather than an area. */
  line: boolean;
}

interface ResizeSession {
  pointer: number;
  start: number;
  beforePx: number;
  afterPx: number;
  sizes: number[];
  latest: number[];
}

function placeStyle(rect: DockRect, order: number): string {
  return `--l:${linCss(rect.left)};--t:${linCss(rect.top)};--w:${linCss(rect.width)};--h:${linCss(rect.height)};--order:${order}`;
}

const byId = (a: { group: { group: { id: string } } }, b: { group: { group: { id: string } } }) =>
  a.group.group.id.localeCompare(b.group.group.id, undefined, { numeric: true });

/**
 * Tab groups in split views, arranged by dragging tabs like VS Code's
 * editors: onto another tab bar to join that group, onto a side of a group's
 * content to split it, or onto its centre to join it. Splitters between
 * groups resize them (pointer, arrow keys; double-click shares the space
 * equally). Groups, views and splitters are absolutely positioned siblings,
 * so rearranging never remounts a view (scroll position, page, selection and
 * toggles are kept). Narrow screens stack the groups instead.
 */
export function Dock<T extends string>({ layout, tabs, labels, available, renderTab, customised, onActivate, onMove, onResize, onReset }: Props<T>) {
  const root = useRef<HTMLDivElement>(null);
  /** The tab being dragged; a ref, because the drag events that follow need it before any re-render. */
  const dragged = useRef<T | null>(null);
  const [dragging, setDragging] = useState<T | null>(null);
  const [drop, setDrop] = useState<DropPreview | null>(null);
  /** Sizes of the split being resized, shown live and saved when the handle is released. */
  const [resizing, setResizing] = useState<{ split: string; sizes: number[]; direction: "row" | "column" } | null>(null);
  const session = useRef<ResizeSession | null>(null);

  const shown = resizing ? resizeSplit(layout, resizing.split, resizing.sizes) : layout;
  const visible = visibleDock(shown, (t) => available.has(t));
  if (!visible) return null;
  const { groups, splitters } = dockGeometry(visible, GAP);
  const firstGroup = groups[0]?.group.group.id;

  const relative = (r: { left: number; top: number; width: number; height: number }): Box => {
    const d = root.current!.getBoundingClientRect();
    return { left: r.left - d.left, top: r.top - d.top, width: r.width, height: r.height };
  };

  // ------------------------------------------------------------ tab dragging

  const startDrag = (e: DragEvent, tab: T) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(TAB_DRAG_TYPE, tab);
    e.dataTransfer.effectAllowed = "move";
    dragged.current = tab;
    // After the browser has taken its picture of the tab: re-rendering during dragstart can cancel the drag.
    setTimeout(() => setDragging(dragged.current), 0);
  };
  const endDrag = () => {
    dragged.current = null;
    setDragging(null);
    setDrop(null);
  };

  /** Over a tab bar: insert before the tab under the pointer's left half. */
  const tabBarDrop = (e: DragEvent, placed: PlacedGroup<T>): DropPreview | null => {
    const tab = dragged.current;
    const bar = e.currentTarget as HTMLElement;
    if (!tab) return null;
    const buttons = Array.from(bar.querySelectorAll<HTMLElement>('[role="tab"]'));
    let k = buttons.findIndex((b) => {
      const r = b.getBoundingClientRect();
      return e.clientX < r.left + r.width / 2;
    });
    if (k < 0) k = buttons.length;
    const { group, tabs: groupTabs } = placed.group;
    const next = groupTabs[k];
    const target = { group: group.id, index: next === undefined ? group.tabs.length : group.tabs.indexOf(next) };
    if (isMoveNoop(layout, tab, target)) return null;
    const barRect = bar.getBoundingClientRect();
    const x = buttons[k]?.getBoundingClientRect().left ?? buttons[buttons.length - 1]?.getBoundingClientRect().right ?? barRect.left;
    return { target, box: relative({ left: x - 1, top: barRect.top + 5, width: 2, height: barRect.height - 10 }), line: true };
  };

  /** Over a group's content: split off the side nearest to the pointer, or join the group in its centre. */
  const viewDrop = (e: DragEvent, placed: PlacedGroup<T>): DropPreview | null => {
    const tab = dragged.current;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (!tab || !r.width || !r.height) return null;
    const side = zoneAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    const target = { group: placed.group.group.id, side };
    if (isMoveNoop(layout, tab, target)) return null;
    const box = relative(r);
    if (side === "left" || side === "right") box.width /= 2;
    if (side === "top" || side === "bottom") box.height /= 2;
    if (side === "right") box.left += box.width;
    if (side === "bottom") box.top += box.height;
    return { target, box, line: false };
  };

  type Finder = (e: DragEvent, placed: PlacedGroup<T>) => DropPreview | null;
  const isTabDrag = (e: DragEvent) => !!dragged.current && !!e.dataTransfer?.types.includes(TAB_DRAG_TYPE);
  /** dragenter and dragover: both must be cancelled for a drop to be accepted (HTML drag and drop). */
  const hover = (find: Finder, placed: PlacedGroup<T>) => (e: DragEvent) => {
    const next = isTabDrag(e) ? find(e, placed) : null;
    if (!next) return; // the dock's own handler clears the outline
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    setDrop((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  };
  const dropOn = (find: Finder, placed: PlacedGroup<T>) => (e: DragEvent) => {
    const tab = dragged.current;
    const next = tab && isTabDrag(e) ? find(e, placed) : null;
    if (!tab || !next) return;
    e.preventDefault();
    endDrag();
    onMove(tab, next.target);
  };

  // ---------------------------------------------------------------- splitters

  const containerPx = (direction: "row" | "column") => {
    const d = root.current!.getBoundingClientRect();
    return direction === "row" ? d.width : d.height;
  };
  const startResize = (e: PointerEvent, s: PlacedSplitter<T>) => {
    if (e.button !== 0 || !root.current) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const total = containerPx(s.split.direction);
    const row = s.split.direction === "row";
    session.current = {
      pointer: e.pointerId,
      start: row ? e.clientX : e.clientY,
      beforePx: linPx(s.beforeSize, total),
      afterPx: linPx(s.afterSize, total),
      sizes: s.split.sizes,
      latest: s.split.sizes,
    };
    setResizing({ split: s.split.id, sizes: s.split.sizes, direction: s.split.direction });
  };
  const moveResize = (e: PointerEvent, s: PlacedSplitter<T>) => {
    const from = session.current;
    if (!from || from.pointer !== e.pointerId) return;
    const delta = (s.split.direction === "row" ? e.clientX : e.clientY) - from.start;
    from.latest = shiftSizes(from.sizes, s.before, s.after, from.beforePx, from.afterPx, delta, MIN_SIZE[s.split.direction]);
    setResizing({ split: s.split.id, sizes: from.latest, direction: s.split.direction });
  };
  const endResize = (e: PointerEvent, s: PlacedSplitter<T>) => {
    const from = session.current;
    if (!from || from.pointer !== e.pointerId) return;
    session.current = null;
    setResizing(null);
    if (from.latest !== from.sizes) onResize(s.split.id, from.latest);
  };
  const keyResize = (e: KeyboardEvent, s: PlacedSplitter<T>) => {
    const row = s.split.direction === "row";
    const step = e.key === (row ? "ArrowLeft" : "ArrowUp") ? -KEY_STEP : e.key === (row ? "ArrowRight" : "ArrowDown") ? KEY_STEP : 0;
    if (!step || !root.current) return;
    e.preventDefault();
    const total = containerPx(s.split.direction);
    onResize(s.split.id, shiftSizes(s.split.sizes, s.before, s.after, linPx(s.beforeSize, total), linPx(s.afterSize, total), step, MIN_SIZE[s.split.direction]));
  };
  const equalise = (s: PlacedSplitter<T>) => {
    const sizes = [...s.split.sizes];
    const half = ((sizes[s.before] ?? 1) + (sizes[s.after] ?? 1)) / 2;
    sizes[s.before] = half;
    sizes[s.after] = half;
    onResize(s.split.id, sizes);
  };
  const share = (s: PlacedSplitter<T>) => {
    const a = s.split.sizes[s.before] ?? 1;
    const b = s.split.sizes[s.after] ?? 1;
    return Math.round((100 * a) / (a + b));
  };

  return (
    <div
      ref={root}
      class={`dock${dragging ? " dock-dragging" : ""}${resizing ? ` dock-resizing dock-resizing-${resizing.direction}` : ""}`}
      onDragOver={(e) => {
        if (!e.defaultPrevented) setDrop(null);
      }}
      onDragLeave={(e) => {
        const to = e.relatedTarget as Node | null;
        if (to && !root.current?.contains(to)) setDrop(null);
      }}
    >
      {[...groups].sort(byId).map((placed) => {
        const { group, tabs: groupTabs, active } = placed.group;
        return (
          <div key={group.id} class="dock-frame" style={placeStyle(placed.rect, placed.order * 2)}>
            <div class="dock-tabbar" onDragEnter={hover(tabBarDrop, placed)} onDragOver={hover(tabBarDrop, placed)} onDrop={dropOn(tabBarDrop, placed)}>
              <div class="tabs" role="tablist" aria-label="Result tabs (drag a tab to arrange split views)">
                {groupTabs.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    id={`dock-tab-${t}`}
                    aria-selected={active === t}
                    aria-controls={active === t ? `dock-panel-${t}` : undefined}
                    class={`tab${active === t ? " tab-active" : ""}${dragging === t ? " tab-dragging" : ""}`}
                    draggable={true}
                    onDragStart={(e) => startDrag(e, t)}
                    onDragEnd={endDrag}
                    onClick={() => onActivate(t)}
                  >
                    {labels[t]}
                  </button>
                ))}
              </div>
              <div class="dock-actions">
                {groupTabs.length > 1 && (
                  <>
                    <button
                      type="button"
                      class="btn btn-ghost small dock-action"
                      title={`Move “${labels[active]}” to a new group on the right`}
                      aria-label={`Move ${labels[active]} to a new group on the right`}
                      onClick={() => onMove(active, { group: group.id, side: "right" })}
                    >
                      <SplitRightIcon />
                    </button>
                    <button
                      type="button"
                      class="btn btn-ghost small dock-action"
                      title={`Move “${labels[active]}” to a new group below`}
                      aria-label={`Move ${labels[active]} to a new group below`}
                      onClick={() => onMove(active, { group: group.id, side: "bottom" })}
                    >
                      <SplitDownIcon />
                    </button>
                  </>
                )}
                {customised && group.id === firstGroup && (
                  <button type="button" class="btn btn-ghost small dock-action" title="Reset the layout: all tabs in one group" aria-label="Reset the layout" onClick={onReset}>
                    <ResetLayoutIcon />
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {tabs.map((t) => {
        const placed = groups.find((p) => p.group.active === t);
        if (!placed) return null;
        return (
          <div
            key={t}
            id={`dock-panel-${t}`}
            role="tabpanel"
            aria-labelledby={`dock-tab-${t}`}
            class="dock-view"
            style={placeStyle(placed.rect, placed.order * 2 + 1)}
            onDragEnter={hover(viewDrop, placed)}
            onDragOver={hover(viewDrop, placed)}
            onDrop={dropOn(viewDrop, placed)}
          >
            {renderTab(t)}
          </div>
        );
      })}

      {splitters.map((s) => (
        <div
          key={`${s.split.id}:${s.before}`}
          class={`dock-splitter dock-splitter-${s.split.direction}`}
          role="separator"
          tabIndex={0}
          aria-orientation={s.split.direction === "row" ? "vertical" : "horizontal"}
          aria-label="Resize the split views"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={share(s)}
          title="Drag to resize; double-click to share the space equally"
          style={placeStyle(s.rect, 0)}
          onPointerDown={(e) => startResize(e, s)}
          onPointerMove={(e) => moveResize(e, s)}
          onPointerUp={(e) => endResize(e, s)}
          onPointerCancel={(e) => endResize(e, s)}
          onLostPointerCapture={(e) => endResize(e, s)}
          onKeyDown={(e) => keyResize(e, s)}
          onDblClick={() => equalise(s)}
        />
      ))}

      {drop && (
        <div
          class={`dock-drop${drop.line ? " dock-drop-line" : ""}`}
          aria-hidden="true"
          style={`left:${drop.box.left}px;top:${drop.box.top}px;width:${drop.box.width}px;height:${drop.box.height}px`}
        />
      )}
    </div>
  );
}
