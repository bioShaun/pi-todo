# CLAUDE.md - pi-todo Extension

## Overview
`pi-todo` is a standalone, lightweight todo extension designed for Pi 1.3.0. It provides an explicit structured tool (`todo`), a slash command (`/todos`), an above-editor TUI widget, session branch persistence, and persistent context injection across compaction.

## Architecture & Interfaces

### 1. Source Structure
- `index.ts`: Entrypoint registering the `todo` tool (with `outputSchema` and `structuredContent`), `/todos` slash command, dynamic widget factory (`render(width)`), and lifecycle listeners (`session_start`, `session_tree`, `session_compact`).
- `context.ts`: Context snapshot formatting, list equality checks, projection latest snapshot extraction, and branch/compaction recovery logic.
- `state.ts`: Core data model (`TodoItem`, `TodoStateSnapshot`), validation functions, immutable cloning, atomic mutations, and session branch restoration logic.
- `view.ts`: Status label mapping, terminal string sanitization (C0/C1 controls, OSC/DCS/APC sequences, bidi controls, collapsed newlines), actual-width truncation (`truncateToWidth`, `visibleWidth` from `@earendil-works/pi-tui`), and theme-aware widget/dialog rendering. Widget components implement `render(width)` and `invalidate()`.
  - `renderWidgetLines(items, width, theme?, options?)` renders a text-only progress header, at most 6 tasks, and a details hint with the hidden count. Priorities are in progress > blocked > pending > completed, with lower IDs selected first within each status; selected tasks display in ID order. `options.collapsed` shows only the summary. All lines are truncated to the given width.
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
- Layout: a text-only progress header followed by at most 6 tasks in ID order, with blocked reasons on separate lines and a `/todos` details hint. Selection prioritizes in progress > blocked > pending > completed. The summary counts all tasks; hidden tasks remain available in the scrollable `/todos` details view. Alt+T or `/todos toggle` collapses to the summary. All-completed plans remain expanded unless manually collapsed; empty lists hide the widget.
- Line widths are truncated according to terminal column width using `@earendil-works/pi-tui` `truncateToWidth` and measured with `visibleWidth` (supporting CJK and emoji).
- All strings rendered to the UI (tasks, reasons, statuses, notifications) are sanitized to remove C0/C1 control codes, OSC/DCS sequences, and bidi control characters.

### 4. Persistence & Branch State
- Stored as versioned custom session entries via `pi.appendEntry('pi-todo-state', { version: 1, items: [...] })`.
- On `session_start` and `session_tree`, state is restored exclusively from the latest custom entry in `ctx.sessionManager.getBranch()`. Restored IDs must follow the original `1..N` array order; gaps, reordered IDs, and out-of-range IDs invalidate the snapshot.
- An empty branch resets state to empty. Corrupted latest entries trigger a warning notification and reset state to empty (without falling back to older snapshots).

### 5. Persistent Context Snapshots & Prompt Cache Preservation
- The extension does NOT register a `context` hook and never rewrites or filters historical session messages.
- After state persistence succeeds on state-changing `set`, `update`, and `clear` operations, the tool calls `pi.sendMessage` to append a persistent hidden message (`customType: "pi-todo-context"`, `content: JSON.stringify({ todos: items })`, `display: false`, `{ triggerTurn: false }`).
- When all tasks are completed or when cleared, it appends a snapshot with `{ todos: [] }` to update model context semantics without modifying history.
- Context contents contain no volatile timestamps (using host session entry timestamps).
- On `session_start` and `session_tree`, after restoring branch state, it inspects the compaction-aware projection (`buildSessionProjection().messages`); if the latest snapshot differs from the current branch or is missing, it appends a recovery snapshot. If there are no tasks and no previous snapshot in the projection, nothing is appended. Recovery does not duplicate an identical projected snapshot.
- On `session_compact`, if compaction removed the latest snapshot, a recovery snapshot is appended once. For `willRetry: true` (overflow recovery), it delivers via steering (`triggerTurn: true, deliverAs: "steer"`); otherwise `{ triggerTurn: false }`.
- Consecutive model turns verified offline via `convertToLlm` + `convertResponsesMessages` to ensure an append-only message prefix for prompt cache compatibility. Online short-interval usage also showed cache reuse across todo changes; this does not establish the entire remote HTTP prefix or long-term cache retention.

#### Cache regression record and maintenance requirements
The 2026-10-20 fix (`c634801`) removed a `context` hook that filtered all old todo snapshots and appended a transient snapshot at the end of every request. Even unchanged snapshot content moved past newly added assistant/tool messages, breaking the previous request's message prefix. Never reintroduce this pattern. See README's “已知陷阱：临时快照移动导致缓存反复失效” for the incident data and online acceptance procedure.

- Preserve historical message positions. In Pi 1.3.0, streaming `sendMessage(..., { triggerTurn: false })` queues custom messages until `turn_end`, after all tool results. Never insert a snapshot between an assistant tool call and its tool result, including nested codemode execution.
- Detect tool changes by comparing items before/after successful persistence. `list`, validation/persistence failures, and no-ops must not append a context snapshot.
- Queue every actual state change, including both B and the final A in a same-turn `A → B → A` sequence. The persistent projection does not yet include pending custom messages; using it for tool-change deduplication can silently discard the final A. Projection-based deduplication is for lifecycle recovery.
- Preserve empty snapshots for all-completed/cleared plans, branch-aware restoration, compaction-aware projection checks, and `willRetry: true` steering so the retry consumes the recovered snapshot. Other recovery must not start an extra model turn.
- Minimum regression checks after context changes: `npm test` (`tests/context.test.mjs`) and `node scripts/host-smoke.mjs`. Keep real host message conversion prefix assertions, same-turn `A → B → A`, tool-result/snapshot ordering, session reload/tree recovery, manual compaction, retry steering consumption, and recovery deduplication. Implementation lives in `index.ts` and `context.ts`.
- For online acceptance, reload each running window, use an active todo, execute consecutive tools, update status, then complete the plan. Inspect persistent `pi-todo-context` messages and usage over successive requests. A flat `cacheRead` under short intervals warrants prefix inspection before assuming a TTL issue.
- The old run (`tcuni/gpt-6-astra`) stayed at 82,944 cached tokens across requests 13 seconds apart. The new run (`tcuni/gpt-6.1-sol`) had an initial post-reload miss, then 99.37% cache reuse; active-todo and completion updates retained 99.58% and 99.85% reuse. These are observations from different models, not a controlled cost comparison or a claim that reload always misses.
- Pi's cache-miss cost notice is an estimate from usage and model prices, not a separate platform charge. Raw remote HTTP requests and long-idle/30-minute TTL/proxy retention were not verified; do not present these observations as proof of those properties.

## Known Limits & Invariants
- `MAX_ITEMS`: 20 items maximum.
- `MAX_TEXT`: 160 characters maximum per task text (trimmed, non-blank).
- `MAX_REASON`: 240 characters maximum per blocked reason (trimmed, required when status is `blocked`, validated on all items).
- For nonblocked effective status, omitted reason is valid and supplied blank/whitespace-only strings normalize to absent; supplied nonblank strings are validated then discarded. Wrong types and overlong nonblank strings remain invalid. Blocked reasons remain strict: blank values reject, entering blocked requires a nonblank reason, omitted reason on an already-blocked update preserves it, and leaving blocked clears it.
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
