# CLAUDE.md - pi-todo Extension

## Overview
`pi-todo` is a standalone, lightweight todo extension designed for Pi 1.3.0. It provides an explicit structured tool (`todo`), a slash command (`/todos`), an above-editor TUI widget, session branch persistence, and ephemeral context injection across compaction.

## Architecture & Interfaces

### 1. Source Structure
- `index.ts`: Entrypoint registering the `todo` tool (with `outputSchema` and `structuredContent`), `/todos` slash command, dynamic widget factory (`render(width)`), and lifecycle listeners (`session_start`, `session_tree`, `context`).
- `state.ts`: Core data model (`TodoItem`, `TodoStateSnapshot`), validation functions, immutable cloning, atomic mutations, and session branch restoration logic.
- `view.ts`: Status label mapping, terminal string sanitization (C0/C1 controls, OSC/DCS/APC sequences, bidi controls, collapsed newlines), actual-width truncation (`truncateToWidth`, `visibleWidth` from `@earendil-works/pi-tui`), and theme-aware widget/dialog rendering. Widget components implement `render(width)` and `invalidate()`.
  - `renderWidgetLines(items, width, theme?)` renders one progress header line (`待办 c/t` + actual-width bar + `还有 N 项`) plus at most 3 prioritized unfinished rows using status glyphs (`✖`/`◐`/`○`/`✓`); `theme` is optional so headless callers get plain text. The bar is omitted when the header leaves fewer than 5 columns, and all lines are truncated to the given width.
  - `formatTodoDialogTitle(items)` / `formatTodoDialogOptions(items)` produce the `/todos` select title (with progress counts) and option rows.
  - `STATUS_LABELS` stays model-facing (`formatTodoList`, tool text); the widget and dialog use `STATUS_GLYPHS`.
- `scripts/host-smoke.mjs`: Offline actual-host SDK validation of loading, wrapped tools, JSONL persistence, fresh-session restore, tree navigation and context. Run `node scripts/host-smoke.mjs`; no model requests are made, evidence stays under `.work/`.

### 2. Tool Interface (`todo`)
The tool is registered with `executionMode: "sequential"` and requires schema parameters:
- `action`: `"set" | "update" | "list" | "clear"`
- `items`: (For `set`) Required explicit array of `{ text: string, status?: TodoStatus, reason?: string }`
  - Replaces entire existing plan; assigns positive integer IDs 1..N sequentially.
- `updates`: (For `update`) Array of `{ id: number, status?: TodoStatus, text?: string, reason?: string }`
  - Atomic batch execution: validates all updates before applying or persisting.
- `list`: Returns the current todo list without mutations.
- `clear`: Empties the todo list and persists an empty snapshot.

#### Structured Output (`outputSchema`)
All results return `structuredContent` matching `{ items: TodoItem[], error?: string }` alongside text content and `details`.

#### Tool Invocation Examples
- **set**:
  ```json
  {
    "action": "set",
    "items": [
      { "text": "Plan implementation", "status": "in_progress" },
      { "text": "Run regression tests", "status": "pending" }
    ]
  }
  ```
- **update**:
  ```json
  {
    "action": "update",
    "updates": [
      { "id": 1, "status": "completed" },
      { "id": 2, "status": "in_progress" }
    ]
  }
  ```
- **clear**:
  ```json
  {
    "action": "clear"
  }
  ```

### 3. TUI Widget & Actual-Width Rendering
- Widget is registered via a factory function returning `{ render(width: number): string[] }`; the host passes `(tui, theme)` to the factory, and the theme is forwarded to `renderWidgetLines(items, width, theme)` so semantic tokens (`accent`, `success`, `warning`, `muted`, `dim`) follow the active theme. `theme` stays optional for headless rendering.
- Available terminal width is dynamically passed to `renderWidgetLines(items, width, theme)`.
- Layout: one text-only header line (`待办 c/t`, plus `还有 N 项` when rows are hidden) followed by up to 6 task rows in id order: `✓` completed (dimmed text), `◐` in progress (bold), `○` pending, `✖` blocked with its reason. There is deliberately no progress bar or percentage; low-contrast track glyphs are invisible on dark themes. When the plan exceeds the row budget, the most actionable tasks are kept (blocked > in progress > earliest pending) while display order stays by id. All-completed collapses to one `✓ c/t 全部完成` line; an empty list hides the widget.
- Line widths are truncated according to terminal column width using `@earendil-works/pi-tui` `truncateToWidth` and measured with `visibleWidth` (supporting CJK and emoji).
- All strings rendered to the UI (tasks, reasons, statuses, notifications) are sanitized to remove C0/C1 control codes, OSC/DCS sequences, and bidi control characters.

### 4. Persistence & Branch State
- Stored as versioned custom session entries via `pi.appendEntry('pi-todo-state', { version: 1, items: [...] })`.
- On `session_start` and `session_tree`, state is restored exclusively from the latest custom entry in `ctx.sessionManager.getBranch()`. Restored IDs must follow the original `1..N` array order; gaps, reordered IDs, and out-of-range IDs invalidate the snapshot.
- An empty branch resets state to empty. Corrupted latest entries trigger a warning notification and reset state to empty (without falling back to older snapshots).

### 5. Compaction Context Injection
- The `context` event handler removes any previous messages matching `customType: "pi-todo-context"`.
- If there are unfinished tasks (`pending`, `in_progress`, `blocked`), it appends one ephemeral custom message (`role: "custom"`, `display: false`, `timestamp: Date.now()`).
- When all tasks are completed or list is empty, no context message is appended.

## Known Limits & Invariants
- `MAX_ITEMS`: 20 items maximum.
- `MAX_TEXT`: 160 characters maximum per task text (trimmed, non-blank).
- `MAX_REASON`: 240 characters maximum per blocked reason (trimmed, required when status is `blocked`, validated on all items).
- `in_progress` concurrency: At most 1 task may be `in_progress` at any time.
- All validation errors return `{ isError: true, content: [...], structuredContent: { items, error } }` without mutating memory or appending session entries.

## Testing & Validation
Run tests with Node.js built-in test runner:
```bash
npm test
```
Or with custom host root:
```bash
PI_TEST_HOST_ROOT="$HOME/.pi/agent/install/releases/1.3.0/node_modules" npm test
```
Tests load the extension using the real Pi host loader (`loadExtensions` from `@earendil-works/pi-coding-agent/dist/core/extensions/loader.js`) and mock contexts for headless verification.
