import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { TodoStateManager, type TodoItem } from "./state.ts";
import { formatTodoList, formatToolSummary, renderWidgetLines, sanitizeText } from "./view.ts";

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
        Type.Literal("blocked"),
      ], { description: "Initial status (defaults to pending); blocked requires reason" })),
      reason: Type.Optional(Type.String({ description: "Reason why task is blocked (required if status is blocked, 1-240 chars)" })),
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
        Type.Literal("blocked"),
      ], { description: "Updated status; blocked requires reason" })),
      text: Type.Optional(Type.String({ description: "Updated task description (1-160 chars)" })),
      reason: Type.Optional(Type.String({ description: "Reason why task is blocked (required if status is blocked, 1-240 chars)" })),
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
        Type.Literal("blocked"),
      ], { description: "Task status" }),
      reason: Type.Optional(Type.String({ description: "Reason when task is blocked" })),
    }),
    { description: "Current list of todo items" }
  ),
  error: Type.Optional(Type.String({ description: "Error message when action fails" })),
});

export type TodoOutput = Static<typeof TodoOutputSchema>;

export interface TodoExecutionResult {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: TodoOutput;
  details: { items: TodoItem[]; error?: string };
}

function makeError(items: TodoItem[], error: string): TodoExecutionResult {
  return {
    isError: true,
    content: [{ type: "text", text: error }],
    structuredContent: { items, error },
    details: { items, error },
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
    return makeError(stateManager.getItems(), res.error || "Failed to set todos");
  }
  return makeSuccess(stateManager.getItems(), formatToolSummary(stateManager.getItems()));
}

function handleUpdate(stateManager: TodoStateManager, params: TodoParams): TodoExecutionResult {
  if (!params.updates || !Array.isArray(params.updates) || params.updates.length === 0) {
    return makeError(stateManager.getItems(), "Updates array cannot be empty for 'update' action");
  }
  const res = stateManager.update(params.updates);
  if (!res.success) {
    return makeError(stateManager.getItems(), res.error || "Failed to update todos");
  }
  return makeSuccess(stateManager.getItems(), formatToolSummary(stateManager.getItems()));
}

function handleClear(stateManager: TodoStateManager): TodoExecutionResult {
  const res = stateManager.clear();
  if (!res.success) {
    return makeError(stateManager.getItems(), res.error || "Failed to clear todos");
  }
  return makeSuccess([], "Todo list cleared.");
}

export default function todoExtension(pi: ExtensionAPI): void {
  const stateManager = new TodoStateManager((type, data) => {
    pi.appendEntry(type, data);
  });

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
      () => ({
        render(width: number): string[] {
          return renderWidgetLines(stateManager.getItems(), width) ?? [];
        },
        invalidate(): void {
          // Rendering reads the current state and width without caching.
        },
      }),
      { placement: "aboveEditor" }
    );
  }

  pi.registerTool({
    name: "todo",
    label: "Todo List",
    description: "Manage a structured todo list for tracking progress during complex tasks.",
    executionMode: "sequential",
    promptGuidelines: [
      "Use a short 3-6 step plan for multi-step work; skip todos for simple questions or one-step tasks.",
      "Update statuses explicitly at milestones; at most one task in_progress; blocked requires a reason.",
      "Delegated implementation is not verified completion: mark completed only after checking the required evidence.",
      "Replace or clear the plan when switching to an unrelated task.",
    ],
    parameters: TodoParamsSchema,
    outputSchema: TodoOutputSchema,
    async execute(_toolCallId: string, params: TodoParams, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext): Promise<TodoExecutionResult> {
      if (!params || !params.action) {
        return makeError(stateManager.getItems(), "Action is required");
      }

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
        updateWidget(ctx);
      }
      return result;
    },
  });

  pi.registerCommand("todos", {
    description: "Display the full todo list",
    handler: async (_args: string, ctx?: ExtensionContext): Promise<void> => {
      if (!ctx || ctx.mode !== "tui" || !ctx.ui) {
        return;
      }
      const items = stateManager.getItems();
      const options = formatTodoList(items);
      await ctx.ui.select("待办事项清单 (按 ESC 退出)", options);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const branch = ctx.sessionManager?.getBranch() || [];
    stateManager.restoreFromBranch(branch, (msg) => {
      ctx.ui?.notify?.(sanitizeText(msg), "warning");
    });
    updateWidget(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    const branch = ctx.sessionManager?.getBranch() || [];
    stateManager.restoreFromBranch(branch, (msg) => {
      ctx.ui?.notify?.(sanitizeText(msg), "warning");
    });
    updateWidget(ctx);
  });

  pi.on("context", async (event, _ctx) => {
    const messages = event.messages || [];
    const filtered = messages.filter(
      (message: AgentMessage) => message.role !== "custom" || message.customType !== "pi-todo-context"
    );

    const items = stateManager.getItems();
    const unfinished = items.filter((i) => i.status !== "completed");
    if (unfinished.length === 0) {
      return { messages: filtered };
    }

    const contextMsg: Extract<AgentMessage, { role: "custom" }> = {
      role: "custom",
      customType: "pi-todo-context",
      content: JSON.stringify({
        todos: items.map((i) => ({
          id: i.id,
          text: i.text,
          status: i.status,
          ...(i.reason ? { reason: i.reason } : {}),
        })),
      }),
      display: false,
      timestamp: Date.now(),
    };

    return {
      messages: [...filtered, contextMsg],
    };
  });
}
