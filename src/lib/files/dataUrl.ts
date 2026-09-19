/**
 * Base64 data-URI encoding of the uploaded file, done by the browser's
 * FileReader (off the main thread) so large PDFs do not freeze the UI.
 */
export function fileToDataUrl(file: Blob, mimeType?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return reject(new Error("Unexpected FileReader result"));
      // FileReader uses the blob's own type; rewrite it if the caller knows better.
      if (mimeType && !result.startsWith(`data:${mimeType};`)) {
        const comma = result.indexOf(",");
        resolve(`data:${mimeType};base64,${result.slice(comma + 1)}`);
      } else {
        resolve(result);
      }
    };
    reader.readAsDataURL(file);
  });
}
