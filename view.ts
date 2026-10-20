import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TodoItem, TodoStatus } from "./state.ts";

export { visibleWidth };

export const MAX_WIDGET_ITEMS = 6;

/**
 * Foreground theme tokens used by the todo UI. This is a subset of the host
 * `ThemeColor` tokens, so a host `Theme` satisfies `TodoTheme` structurally.
 */
export type TodoThemeToken = "accent" | "success" | "warning" | "muted" | "dim";

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

/** Pure presentation state: never persisted in the task snapshot. */
export interface TodoViewOptions {
  collapsed?: boolean;
}

function rail(theme?: TodoTheme): string {
  return paint(theme, "dim", "│") + " ";
}

function renderHeaderLine(items: TodoItem[], maxWidth: number, theme: TodoTheme | undefined, collapsed: boolean): string {
  const completed = items.filter(item => item.status === "completed").length;
  const blocked = items.filter(item => item.status === "blocked").length;
  const summary = `${completed}/${items.length} ${completed === items.length ? "全部完成" : "完成"}`;
  const line = rail(theme) + paint(theme, "muted", `${collapsed ? "▸" : "▾"} 待办 `)
    + paintBold(theme, paint(theme, completed === items.length ? "success" : "accent", summary))
    + (blocked ? paint(theme, "warning", ` · ${blocked} 项受阻`) : "");
  const hint = ` · Alt+T ${collapsed ? "展开" : "折叠"}`;
  // Preserve counts and warnings before the optional keyboard hint.
  return truncateText(line + (visibleWidth(line + hint) <= maxWidth ? paint(theme, "dim", hint) : ""), maxWidth);
}

function renderTaskLines(item: TodoItem, idWidth: number, maxWidth: number, theme?: TodoTheme, wrap = false): string[] {
  const prefix = rail(theme) + paint(theme, statusToken(item.status), statusGlyph(item.status)) + " "
    + paint(theme, "dim", `#${item.id}`.padEnd(idWidth)) + " ";
  const indent = rail(theme) + " ".repeat(idWidth + 3);
  const style = (text: string): string => item.status === "in_progress"
    ? paintBold(theme, paint(theme, "accent", text))
    : item.status === "completed" ? paint(theme, "muted", text) : text;
  const title = sanitizeText(item.text);
  const chunks = wrap ? wrapTextWithAnsi(title, Math.max(1, maxWidth - visibleWidth(prefix))) : [title];
  const lines = chunks.map((chunk, i) => truncateText((i ? indent : prefix) + style(chunk), maxWidth));
  if (item.status === "blocked" && item.reason) {
    const reason = sanitizeText(item.reason);
    const reasonPrefix = indent + paint(theme, "warning", "└ ");
    const chunks = wrap ? wrapTextWithAnsi(reason, Math.max(1, maxWidth - visibleWidth(reasonPrefix))) : [reason];
    chunks.forEach((chunk, i) => lines.push(truncateText(
      (i ? indent + "  " : reasonPrefix) + paint(theme, "warning", chunk), maxWidth)));
  }
  return lines;
}

export function renderWidgetLines(
  items: TodoItem[],
  maxWidth: number = 80,
  theme?: TodoTheme,
  options: TodoViewOptions = {}
): string[] | undefined {
  if (items.length === 0) return undefined;
  if (maxWidth <= 0) return [];
  const lines = [renderHeaderLine(items, maxWidth, theme, options.collapsed === true)];
  if (options.collapsed) return lines;
  const idWidth = Math.max(...items.map(item => String(item.id).length)) + 1;
  const priority: Record<TodoStatus, number> = { in_progress: 0, blocked: 1, pending: 2, completed: 3 };
  const shown = [...items]
    .sort((a, b) => priority[a.status] - priority[b.status] || a.id - b.id)
    .slice(0, MAX_WIDGET_ITEMS)
    .sort((a, b) => a.id - b.id);
  for (const item of shown) lines.push(...renderTaskLines(item, idWidth, maxWidth, theme));
  const hidden = items.length - shown.length;
  const hint = hidden ? `另有 ${hidden} 项 · /todos 查看全部` : "/todos 查看详情";
  lines.push(truncateText(rail(theme) + paint(theme, "dim", hint), maxWidth));
  return lines;
}

/** Full, wrapped text for the read-only scrollable details view. */
export function renderTodoDetailLines(items: TodoItem[], maxWidth: number, theme?: TodoTheme): string[] {
  if (maxWidth <= 0) return [];
  if (!items.length) return [truncateText("暂无待办事项", maxWidth)];
  const idWidth = Math.max(...items.map(item => String(item.id).length)) + 1;
  return items.flatMap(item => renderTaskLines(item, idWidth, maxWidth, theme, true));
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
