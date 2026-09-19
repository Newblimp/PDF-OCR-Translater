/** Classify uploads. Only these kinds are accepted by the drop zone. */

export type FileKind = "pdf" | "image" | "text";

export const ACCEPTED_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".txt", ".md"] as const;
export const ACCEPT_ATTRIBUTE = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  "text/markdown",
  ...ACCEPTED_EXTENSIONS,
].join(",");

/** Returns the kind and the MIME type to use when sending the file. */
export function classifyFile(file: File): { kind: FileKind; mimeType: string } | null {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return { kind: "pdf", mimeType: "application/pdf" };
  if (type === "image/png" || name.endsWith(".png")) return { kind: "image", mimeType: "image/png" };
  if (type === "image/jpeg" || name.endsWith(".jpg") || name.endsWith(".jpeg")) return { kind: "image", mimeType: "image/jpeg" };
  if (type === "image/webp" || name.endsWith(".webp")) return { kind: "image", mimeType: "image/webp" };
  if (type.startsWith("text/") || name.endsWith(".txt") || name.endsWith(".md")) return { kind: "text", mimeType: "text/plain" };
  return null;
}
