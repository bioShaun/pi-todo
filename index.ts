import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { matchesKey } from "@earendil-works/pi-tui";
import { TodoStateManager, areTodoItemsEqual, type TodoItem } from "./state.ts";
import {
  formatTodoContextContent,
  getLatestTodoContextContent,
  shouldAppendContextSnapshot,
  TODO_CONTEXT_TYPE,
} from "./context.ts";
import {
  formatTodoDialogTitle,
  formatToolSummary,
  renderWidgetLines,
  sanitizeText,
  renderTodoDetailLines,
  truncateText,
} from "./view.ts";

export const TodoParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("set"),
    Type.Literal("update"),
    Type.Literal("list"),
    Type.Literal("clear"),
  ], { description: "Action to perform: 'set' replaces entire plan, 'update' modifies tasks by id, 'list' views current tasks, 'clear' removes all tasks" }),
  items: Type.Optional(Type.Array(
    Type.Object({
      text: Type.String({ description: "Task description (1-160 chars)" }),
      status: Type.Optional(Type.Union([
        Type.Literal("pending"),
        Type.Literal("in_progress"),
        Type.Literal("completed"),
        Type.Literal("cancelled"),
        Type.Literal("blocked"),
      ], { description: "Initial status (defaults to pending); blocked requires reason; cancelled records dropped work" })),
      reason: Type.Optional(Type.String({ description: "Blocked status requires a nonblank reason (1-240 chars); blank reasons on nonblocked tasks are ignored" })),
    }),
    { description: "Array of items for 'set' action; replaces the entire existing plan" }
  )),
  updates: Type.Optional(Type.Array(
    Type.Object({
      id: Type.Integer({ minimum: 1, description: "Task ID to update" }),
      status: Type.Optional(Type.Union([
        Type.Literal("pending"),
        Type.Literal("in_progress"),
        Type.Literal("completed"),
        Type.Literal("cancelled"),
        Type.Literal("blocked"),
      ], { description: "Updated status; blocked requires reason; cancelled records dropped work" })),
      text: Type.Optional(Type.String({ description: "Updated task description (1-160 chars)" })),
      reason: Type.Optional(Type.String({ description: "Blocked status requires a nonblank reason (1-240 chars); blank reasons on nonblocked tasks are ignored" })),
    }),
    { description: "Array of updates for 'update' action; modifies tasks by positive integer id" }
  )),
});

export type TodoParams = Static<typeof TodoParamsSchema>;

export const TodoOutputSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      id: Type.Integer({ minimum: 1, description: "Sequential task ID (1..N)" }),
      text: Type.String({ description: "Task description" }),
      status: Type.Union([
        Type.Literal("pending"),
        Type.Literal("in_progress"),
        Type.Literal("completed"),
        Type.Literal("cancelled"),
        Type.Literal("blocked"),
      ], { description: "Task status" }),
      reason: Type.Optional(Type.String({ description: "Reason when task is blocked" })),
    }),
    { description: "Current list of todo items" }
  ),
  error: Type.Optional(Type.String({ description: "Summary error message when action fails" })),
  errors: Type.Optional(Type.Array(Type.String({ description: "Individual validation error" }), {
    description: "All independent validation errors collected in this batch",
  })),
});

export type TodoOutput = Static<typeof TodoOutputSchema>;

export interface TodoExecutionResult {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: TodoOutput;
  details: { items: TodoItem[]; error?: string; errors?: string[] };
}

function makeError(items: TodoItem[], error: string, errors?: string[]): TodoExecutionResult {
  const allErrors = errors && errors.length > 0 ? errors : [error];
  return {
    isError: true,
    content: [{ type: "text", text: error }],
    structuredContent: { items, error, errors: allErrors },
    details: { items, error, errors: allErrors },
  };
}

function makeSuccess(items: TodoItem[], text: string): TodoExecutionResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: { items },
    details: { items },
  };
}

function handleSet(stateManager: TodoStateManager, params: TodoParams): TodoExecutionResult {
  if (!params.items || !Array.isArray(params.items)) {
    return makeError(stateManager.getItems(), "Items array is required for 'set' action");
  }
  const res = stateManager.set(params.items);
  if (!res.success) {
    return makeError(stateManager.getItems(), res.error || "Failed to set todos", res.errors);
  }
  return makeSuccess(stateManager.getItems(), formatToolSummary(stateManager.getItems()));
}

function handleUpdate(stateManager: TodoStateManager, params: TodoParams): TodoExecutionResult {
  if (!params.updates || !Array.isArray(params.updates) || params.updates.length === 0) {
    return makeError(stateManager.getItems(), "Updates array cannot be empty for 'update' action");
  }
  const res = stateManager.update(params.updates);
  if (!res.success) {
    return makeError(stateManager.getItems(), res.error || "Failed to update todos", res.errors);
  }
  return makeSuccess(stateManager.getItems(), formatToolSummary(stateManager.getItems()));
}

function handleClear(stateManager: TodoStateManager): TodoExecutionResult {
  const res = stateManager.clear();
  if (!res.success) {
    return makeError(stateManager.getItems(), res.error || "Failed to clear todos", res.errors);
  }
  return makeSuccess([], "Todo list cleared.");
}

export default function todoExtension(pi: ExtensionAPI): void {
  let collapsed = false;
  const stateManager = new TodoStateManager((type, data) => {
    pi.appendEntry(type, data);
  });

  function syncContextSnapshot(
    ctx?: ExtensionContext,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }
  ): void {
    const items = stateManager.getItems();
    const messages = ctx?.sessionManager?.buildSessionProjection?.().messages;
    const latestContent = getLatestTodoContextContent(messages);
    if (!shouldAppendContextSnapshot(items, latestContent)) {
      return;
    }
    const content = formatTodoContextContent(items);
    pi.sendMessage(
      {
        customType: TODO_CONTEXT_TYPE,
        content,
        display: false,
      },
      options ?? { triggerTurn: false }
    );
  }

  function updateWidget(ctx?: ExtensionContext): void {
    if (!ctx || ctx.mode !== "tui" || !ctx.ui) {
      return;
    }
    const items = stateManager.getItems();
    if (items.length === 0) {
      ctx.ui.setWidget("pi-todo", undefined, { placement: "aboveEditor" });
      return;
    }
    ctx.ui.setWidget(
      "pi-todo",
      (_tui, theme) => ({
        render(width: number): string[] {
          return renderWidgetLines(stateManager.getItems(), width, theme, { collapsed }) ?? [];
        },
        invalidate(): void {
          // Rendering reads the current state and width without caching.
        },
      }),
      { placement: "aboveEditor" }
    );
  }

  function toggleTodos(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || !ctx.ui) return;
    if (stateManager.getItems().length === 0) {
      ctx.ui.notify("暂无待办事项", "info");
      return;
    }
    collapsed = !collapsed;
    updateWidget(ctx);
  }

  pi.registerShortcut("alt+t", {
    description: "展开或折叠待办列表",
    handler: toggleTodos,
  });

  pi.registerTool({
    name: "todo",
    label: "Todo List",
    description: "Manage a structured todo list for tracking progress during complex tasks.",
    executionMode: "sequential",
    promptGuidelines: [
      "Use a short 3-6 step plan for multi-step work; skip todos for simple questions or one-step tasks.",
      "Update statuses explicitly at milestones; at most one task in_progress; blocked requires a reason.",
      "Mark dropped work cancelled instead of deleting or renumbering the plan; completed means actually done.",
      "Delegated implementation is not verified completion: mark completed only after checking the required evidence.",
      "Replace or clear the plan when switching to an unrelated task.",
    ],
    parameters: TodoParamsSchema,
    outputSchema: TodoOutputSchema,
    async execute(_toolCallId: string, params: TodoParams, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext): Promise<TodoExecutionResult> {
      if (!params || !params.action) {
        return makeError(stateManager.getItems(), "Action is required");
      }

      const prevItems = stateManager.getItems();
      let result: TodoExecutionResult;
      switch (params.action) {
        case "set":
          result = handleSet(stateManager, params);
          break;
        case "update":
          result = handleUpdate(stateManager, params);
          break;
        case "list":
          result = makeSuccess(stateManager.getItems(), formatToolSummary(stateManager.getItems()));
          break;
        case "clear":
          result = handleClear(stateManager);
          break;
        default: {
          const actionName = String((params as Record<string, unknown>).action);
          return makeError(stateManager.getItems(), `Invalid action '${actionName}'`);
        }
      }

      if (!result.isError) {
        if (params.action === "set" || params.action === "clear") collapsed = false;
        updateWidget(ctx);

        if (params.action !== "list") {
          const newItems = stateManager.getItems();
          if (!areTodoItemsEqual(prevItems, newItems)) {
            const targetContent = formatTodoContextContent(newItems);
            pi.sendMessage(
              {
                customType: TODO_CONTEXT_TYPE,
                content: targetContent,
                display: false,
              },
              { triggerTurn: false }
            );
          }
        }
      }
      return result;
    },
  });

  pi.registerCommand("todos", {
    description: "查看待办详情；/todos toggle 展开或折叠列表",
    handler: async (args: string, ctx?: ExtensionContext): Promise<void> => {
      if (!ctx || ctx.mode !== "tui" || !ctx.ui) {
        return;
      }
      if (args.trim() === "toggle") {
        toggleTodos(ctx);
        return;
      }
      if (args.trim()) {
        ctx.ui.notify("用法：/todos 或 /todos toggle", "info");
        return;
      }
      const items = stateManager.getItems();
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        let offset = 0;
        let pageSize = 1;
        let totalLines = 0;
        return {
          render(width: number): string[] {
            if (width <= 0) return [];
            const body = renderTodoDetailLines(items, width, theme);
            totalLines = body.length;
            const height = Math.max(1, tui.terminal.rows);
            pageSize = Math.max(1, height - 4);
            offset = Math.max(0, Math.min(offset, totalLines - pageSize));
            const title = truncateText(theme.bold(formatTodoDialogTitle(items)), width);
            const footer = truncateText(theme.fg("dim",
              `Esc 关闭 · ↑↓ 滚动 · PgUp/PgDn 翻页 · ${offset + 1}–${Math.min(offset + pageSize, totalLines)}/${totalLines} 行`), width);
            if (height < 3) return [title, footer].slice(0, height);
            return [title, ...body.slice(offset, offset + pageSize), footer];
          },
          invalidate(): void {},
          handleInput(data: string): void {
            if (matchesKey(data, "escape")) { done(); return; }
            if (matchesKey(data, "up")) offset--;
            else if (matchesKey(data, "down")) offset++;
            else if (matchesKey(data, "pageUp")) offset -= pageSize;
            else if (matchesKey(data, "pageDown")) offset += pageSize;
            else if (matchesKey(data, "home")) offset = 0;
            else if (matchesKey(data, "end")) offset = totalLines;
            else return;
            offset = Math.max(0, Math.min(offset, totalLines - pageSize));
            tui.requestRender();
          },
        };
      });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    collapsed = false;
    const branch = ctx.sessionManager?.getBranch() || [];
    stateManager.restoreFromBranch(branch, (msg) => {
      ctx.ui?.notify?.(sanitizeText(msg), "warning");
    });
    updateWidget(ctx);
    syncContextSnapshot(ctx, { triggerTurn: false });
  });

  pi.on("session_tree", async (_event, ctx) => {
    collapsed = false;
    const branch = ctx.sessionManager?.getBranch() || [];
    stateManager.restoreFromBranch(branch, (msg) => {
      ctx.ui?.notify?.(sanitizeText(msg), "warning");
    });
    updateWidget(ctx);
    syncContextSnapshot(ctx, { triggerTurn: false });
  });

  pi.on("session_compact", async (event, ctx) => {
    const options = event.willRetry
      ? { triggerTurn: true, deliverAs: "steer" as const }
      : { triggerTurn: false };
    syncContextSnapshot(ctx, options);
  });
}
