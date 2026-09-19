/** SHA-256 of a file's bytes, hex encoded. Used as the local OCR cache key. */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashFile(file: Blob): Promise<string> {
  return sha256Hex(await file.arrayBuffer());
}
