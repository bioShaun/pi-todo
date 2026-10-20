import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TodoItem, TodoStatus } from "./state.ts";

export { visibleWidth };

/**
 * Foreground theme tokens used by the todo UI. This is a subset of the host
 * `ThemeColor` tokens, so a host `Theme` satisfies `TodoTheme` structurally.
 */
export type TodoThemeToken = "accent" | "success" | "warning" | "muted" | "dim" | "borderMuted";

/**
 * Minimal structural view of the host `Theme`. Rendering accepts `undefined` so
 * headless callers (and tests) can render plain, unstyled lines.
 */
export interface TodoTheme {
  fg(token: TodoThemeToken, text: string): string;
  bold(text: string): string;
}

/** Model-facing status labels (used in tool output text, not in the widget). */
export const STATUS_LABELS: Record<TodoStatus, string> = {
  pending: "[待办]",
  in_progress: "[进行中]",
  completed: "[已完成]",
  blocked: "[已阻塞]",
};

/** Glyphs shared by the widget and the /todos dialog. */
export const STATUS_GLYPHS: Record<TodoStatus, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "✓",
  blocked: "✖",
};

const STATUS_TOKENS: Record<TodoStatus, TodoThemeToken> = {
  pending: "muted",
  in_progress: "accent",
  completed: "success",
  blocked: "warning",
};

const PRIORITY_ORDER: Record<TodoStatus, number> = {
  blocked: 1,
  in_progress: 2,
  pending: 3,
  completed: 4,
};

const BAR_FILLED = "█";
const BAR_TRACK = "─";
const MAX_BAR_SEGMENTS = 10;
const MIN_BAR_SEGMENTS = 5;
const MAX_WIDGET_ROWS = 3;

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

function paint(theme: TodoTheme | undefined, token: TodoThemeToken, text: string): string {
  if (!theme || text.length === 0) {
    return text;
  }
  return theme.fg(token, text);
}

function paintBold(theme: TodoTheme | undefined, text: string): string {
  if (!theme || text.length === 0) {
    return text;
  }
  return theme.bold(text);
}

function statusGlyph(status: TodoStatus): string {
  return STATUS_GLYPHS[status] ?? "○";
}

function statusToken(status: TodoStatus): TodoThemeToken {
  return STATUS_TOKENS[status] ?? "muted";
}

export function renderProgressBar(
  completed: number,
  total: number,
  segments: number,
  theme?: TodoTheme
): string {
  if (segments <= 0) {
    return "";
  }
  const safeTotal = total > 0 ? total : 1;
  let filled = Math.round((completed / safeTotal) * segments);
  if (completed > 0 && filled < 1) {
    filled = 1;
  }
  if (total > 0 && completed >= total) {
    filled = segments;
  }
  if (filled > segments) {
    filled = segments;
  }
  if (filled < 0) {
    filled = 0;
  }
  return (
    paint(theme, "success", BAR_FILLED.repeat(filled)) +
    paint(theme, "borderMuted", BAR_TRACK.repeat(segments - filled))
  );
}

function renderHeaderLine(
  completed: number,
  total: number,
  hidden: number,
  maxWidth: number,
  theme?: TodoTheme
): string {
  const counts = `${completed}/${total}`;
  const hintText = hidden > 0 ? ` · 还有 ${hidden} 项` : "";
  const plainHeader = ` 待办 ${counts}${hintText}`;
  const barSegments = Math.min(MAX_BAR_SEGMENTS, maxWidth - visibleWidth(plainHeader) - 1);

  let line = ` ${paint(theme, "muted", "待办")} ${paintBold(theme, paint(theme, "accent", counts))}`;
  if (total > 1 && barSegments >= MIN_BAR_SEGMENTS) {
    line += ` ${renderProgressBar(completed, total, barSegments, theme)}`;
  }
  line += paint(theme, "dim", hintText);
  return truncateText(line, maxWidth);
}

function renderTaskLine(item: TodoItem, maxWidth: number, theme?: TodoTheme): string {
  const text = sanitizeText(item.text);
  const styledText = item.status === "in_progress" ? paintBold(theme, text) : text;

  let line =
    ` ${paint(theme, statusToken(item.status), statusGlyph(item.status))} ` +
    `${paint(theme, "dim", `#${item.id}`)} ${styledText}`;

  if (item.status === "blocked" && item.reason) {
    line += `${paint(theme, "dim", " · ")}${paint(theme, "warning", sanitizeText(item.reason))}`;
  }

  return truncateText(line, maxWidth);
}

export function renderWidgetLines(
  items: TodoItem[],
  maxWidth: number = 80,
  theme?: TodoTheme
): string[] | undefined {
  if (items.length === 0) {
    return undefined;
  }
  if (maxWidth <= 0) {
    return [];
  }

  const total = items.length;
  const completedCount = items.filter((i) => i.status === "completed").length;

  if (completedCount === total) {
    const line =
      ` ${paint(theme, "success", statusGlyph("completed"))} ` +
      `${paintBold(theme, paint(theme, "accent", `${completedCount}/${total}`))} ` +
      `${paint(theme, "muted", "全部完成")}`;
    return [truncateText(line, maxWidth)];
  }

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

  const displayItems = unfinished.slice(0, MAX_WIDGET_ROWS);
  const hiddenCount = unfinished.length - displayItems.length;

  const lines: string[] = [
    renderHeaderLine(completedCount, total, hiddenCount, maxWidth, theme),
  ];
  for (const item of displayItems) {
    lines.push(renderTaskLine(item, maxWidth, theme));
  }
  return lines;
}

/** Read-only dialog title for the /todos command. */
export function formatTodoDialogTitle(items: TodoItem[]): string {
  if (items.length === 0) {
    return "待办事项 · 暂无任务 (按 ESC 退出)";
  }
  const completed = items.filter((i) => i.status === "completed").length;
  return `待办事项 · ${completed}/${items.length} 完成 (按 ESC 退出)`;
}

/** Select options for the /todos command: glyph, id, text, and blocked reason. */
export function formatTodoDialogOptions(items: TodoItem[]): string[] {
  if (items.length === 0) {
    return ["(暂无待办事项)"];
  }

  return items.map((item) => {
    let row = `${statusGlyph(item.status)} #${item.id} ${sanitizeText(item.text)}`;
    if (item.status === "blocked" && item.reason) {
      row += ` · ${sanitizeText(item.reason)}`;
    }
    return row;
  });
}

/** Plain, model-facing list with explicit status labels. */
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
