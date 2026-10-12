/** Colours per OCR block type (kept readable in both themes), shared by the bounding-box view and the OCR text view. */
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

/** "aside_text" → "aside text". */
export function blockTypeLabel(type: string): string {
  return type.replace(/_/g, " ");
}
