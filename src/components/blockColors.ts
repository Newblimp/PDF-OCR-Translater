/** Block types on the page views: their colours (kept readable in both themes), labels, and boxes placed over a page. */

/** Colours per OCR block type, shared by the bounding-box views and the OCR text view. */
export const BLOCK_COLORS: Record<string, string> = {
  image: "#d6336c",
  title: "#7048e8",
  text: "#1c7ed6",
  table: "#f08c00",
  header: "#868e96",
  footer: "#868e96",
  caption: "#0ca678",
  list: "#1098ad",
  equation: "#5c940d",
  code: "#5c940d",
  signature: "#e03131",
  references: "#862e9c",
  aside_text: "#adb5bd",
};

/** Image bounding boxes (the figures sent to the vision model). */
export const IMAGE_COLOR = "#d6336c";

export function blockColor(type: string): string {
  return BLOCK_COLORS[type] ?? "#495057";
}

/** What the OCR's block types are called on screen. */
const BLOCK_TYPE_LABELS: Record<string, string> = {
  title: "Title",
  text: "Paragraph",
  list: "List",
  table: "Table",
  caption: "Caption",
  equation: "Equation",
  code: "Code",
  references: "References",
  aside_text: "Side note",
  signature: "Signature",
  image: "Image",
  header: "Page header",
  footer: "Page footer",
};

/** A block type in plain words: "text" → "Paragraph"; a type the app does not know, "new_type" → "New type". */
export function blockTypeLabel(type: string): string {
  const spaced = type.replace(/_/g, " ");
  return BLOCK_TYPE_LABELS[type] ?? spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Inline style placing a box given in page pixels over a page `width` × `height` px (in percent, so it scales with the page), in `color`. */
export function boxStyle(box: { x0: number; y0: number; x1: number; y1: number }, width: number, height: number, color = ""): string {
  const pct = (v: number, total: number) => `${(v / total) * 100}%`;
  return `left:${pct(box.x0, width)};top:${pct(box.y0, height)};width:${pct(box.x1 - box.x0, width)};height:${pct(box.y1 - box.y0, height)};--box-color:${color}`;
}
