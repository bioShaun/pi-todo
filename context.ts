import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TodoItem } from "./state.ts";

export const TODO_CONTEXT_TYPE = "pi-todo-context" as const;

/**
 * Format todo items into persistent context snapshot content.
 * When items is empty or all items are completed, outputs `{ todos: [] }`.
 * Never includes volatile timestamps or ephemeral metadata.
 */
export function formatTodoContextContent(items: readonly TodoItem[]): string {
  const unfinished = items.filter((item: TodoItem) => item.status !== "completed");
  if (unfinished.length === 0) {
    return JSON.stringify({ todos: [] });
  }
  return JSON.stringify({
    todos: items.map((item: TodoItem) => {
      const entry: { id: number; text: string; status: TodoItem["status"]; reason?: string } = {
        id: item.id,
        text: item.text,
        status: item.status,
      };
      if (item.reason !== undefined) {
        entry.reason = item.reason;
      }
      return entry;
    }),
  });
}

/**
 * Checks whether two todo item lists are identical in IDs, text, status, and reason.
 */
export function areTodoItemsEqual(
  a: readonly TodoItem[],
  b: readonly TodoItem[]
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const itemA = a[i];
    const itemB = b[i];
    if (
      itemA.id !== itemB.id ||
      itemA.text !== itemB.text ||
      itemA.status !== itemB.status ||
      itemA.reason !== itemB.reason
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Extracts string content from the latest `pi-todo-context` message in the session projection.
 */
export function getLatestTodoContextContent(
  messages?: readonly AgentMessage[]
): string | undefined {
  if (!messages || messages.length === 0) {
    return undefined;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "custom" && msg.customType === TODO_CONTEXT_TYPE) {
      if (typeof msg.content === "string") {
        return msg.content;
      }
      if (Array.isArray(msg.content)) {
        return (msg.content as Array<{ text?: string }>).map((c) => c.text || "").join("");
      }
      return String(msg.content ?? "");
    }
  }
  return undefined;
}

/**
 * Determines whether a recovery context snapshot should be appended on branch restore or compaction.
 * - If there are no tasks and no previous snapshot in projection: returns false.
 * - If the latest snapshot in projection has identical content: returns false (no duplicate).
 * - Otherwise: returns true (snapshot missing, compacted away, or stale).
 */
export function shouldAppendContextSnapshot(
  items: readonly TodoItem[],
  latestContent: string | undefined
): boolean {
  if (items.length === 0) {
    if (latestContent === undefined) {
      return false;
    }
    return latestContent !== JSON.stringify({ todos: [] });
  }
  const targetContent = formatTodoContextContent(items);
  return latestContent !== targetContent;
}
