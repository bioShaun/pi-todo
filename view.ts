import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TodoItem, TodoStatus } from "./state.ts";

export { visibleWidth };

export const STATUS_LABELS: Record<TodoStatus, string> = {
  pending: "[待办]",
  in_progress: "[进行中]",
  completed: "[已完成]",
  blocked: "[已阻塞]",
};

const PRIORITY_ORDER: Record<TodoStatus, number> = {
  blocked: 1,
  in_progress: 2,
  pending: 3,
  completed: 4,
};

export function sanitizeText(text: string): string {
  if (!text) {
    return "";
  }
  return text
    .replace(/\x1b[\]P_][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b\[[0-9:;<=>?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\x1b/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .trim();
}

export function formatStatusLabel(status: string): string {
  if (status in STATUS_LABELS) {
    return STATUS_LABELS[status as TodoStatus];
  }
  return `[${sanitizeText(status)}]`;
}

export function truncateText(text: string, maxWidth: number = 80): string {
  if (maxWidth <= 0) {
    return "";
  }
  return truncateToWidth(text, maxWidth, "...");
}

export function renderWidgetLines(items: TodoItem[], maxWidth: number = 80): string[] | undefined {
  if (items.length === 0) {
    return undefined;
  }
  if (maxWidth <= 0) {
    return [];
  }

  const total = items.length;
  const completedCount = items.filter((i) => i.status === "completed").length;

  if (completedCount === total) {
    return [truncateText(`待办 ${completedCount}/${total} 完成 · 全部完成`, maxWidth)];
  }

  const activeTask = items.find((i) => i.status === "in_progress");
  const blockedTask = items.find((i) => i.status === "blocked");

  let summary = `待办 ${completedCount}/${total} 完成`;
  if (activeTask) {
    summary += ` · 正在: ${sanitizeText(activeTask.text)}`;
  } else if (blockedTask) {
    summary += ` · 阻塞: ${sanitizeText(blockedTask.reason || blockedTask.text)}`;
  } else {
    summary += ` · 待开始`;
  }

  const lines: string[] = [truncateText(summary, maxWidth)];

  const unfinished = items
    .filter((i) => i.status !== "completed")
    .sort((a, b) => {
      const pa = PRIORITY_ORDER[a.status] || 99;
      const pb = PRIORITY_ORDER[b.status] || 99;
      if (pa !== pb) {
        return pa - pb;
      }
      return a.id - b.id;
    });

  const displayItems = unfinished.slice(0, 3);
  for (const item of displayItems) {
    let row = `#${item.id} ${formatStatusLabel(item.status)} ${sanitizeText(item.text)}`;
    if (item.status === "blocked" && item.reason) {
      row += ` (原因: ${sanitizeText(item.reason)})`;
    }
    lines.push(truncateText(row, maxWidth));
  }

  return lines;
}

export function formatTodoList(items: TodoItem[]): string[] {
  if (items.length === 0) {
    return ["(暂无待办事项)"];
  }

  return items.map((item) => {
    let row = `#${item.id} ${formatStatusLabel(item.status)} ${sanitizeText(item.text)}`;
    if (item.status === "blocked" && item.reason) {
      row += ` (原因: ${sanitizeText(item.reason)})`;
    }
    return row;
  });
}

export function formatToolSummary(items: TodoItem[]): string {
  if (items.length === 0) {
    return "Todo list is empty.";
  }
  const lines = formatTodoList(items);
  return lines.join("\n");
}
