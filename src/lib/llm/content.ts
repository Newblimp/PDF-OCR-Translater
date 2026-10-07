/**
 * The user message of a `JsonChatRequest`, in the order every provider sends
 * it: the shared context, then each image after a short label carrying its
 * id, then the task. Keeping the shared part first lets providers cache it.
 */
import type { JsonChatRequest } from "./provider";

export type UserPart = { type: "text"; text: string } | { type: "image"; id: string; dataUrl: string };

export interface UserMessage {
  parts: UserPart[];
  /** Index of the last part of the shared prefix (context and images); -1 when there is none. */
  prefixEnd: number;
}

export function userMessage(request: JsonChatRequest): UserMessage {
  const parts: UserPart[] = [];
  if (request.context) parts.push({ type: "text", text: request.context });
  for (const image of request.images ?? []) {
    parts.push({ type: "text", text: `Image "${image.id}":` });
    parts.push({ type: "image", id: image.id, dataUrl: image.dataUrl });
  }
  const prefixEnd = parts.length - 1;
  parts.push({ type: "text", text: request.user });
  return { parts, prefixEnd };
}

/** The whole user message as one string when it has no images, else null. */
export function plainUserText(message: UserMessage): string | null {
  if (message.parts.some((p) => p.type === "image")) return null;
  return message.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n\n");
}
