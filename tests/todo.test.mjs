import test from "node:test";
import assert from "node:assert/strict";
import { createExtensionTestHarness, createThemeStub } from "./harness.mjs";

test("registration: registers todo tool and /todos slash command without interfering with tools", async () => {
  const harness = await createExtensionTestHarness();
  assert.ok(harness.tool, "todo tool should be registered");
  assert.equal(harness.tool.definition.name, "todo");
  assert.equal(harness.tool.definition.executionMode, "sequential");
  assert.ok(harness.tool.definition.promptGuidelines?.length > 0, "guidelines present");
  assert.ok(harness.todosCmd, "/todos command registered");
});

test("sequential ids and four states: set creates sequential ids 1..N and supports pending, in_progress, completed, blocked", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, createMockContext, customEntries } = harness;
  const { ctx } = createMockContext();

  const res = await tool.definition.execute("call-1", {
    action: "set",
    items: [
      { text: "Task A", status: "pending" },
      { text: "Task B", status: "in_progress" },
      { text: "Task C", status: "blocked", reason: "waiting for specs" },
      { text: "Task D", status: "completed" },
    ],
  }, undefined, undefined, ctx);

  assert.equal(res.isError, undefined, "set should succeed: " + JSON.stringify(res));
  assert.equal(customEntries.length, 1, "persisted snapshot");
  const items = customEntries[0].data.items;
  assert.equal(items.length, 4);
  assert.equal(items[0].id, 1);
  assert.equal(items[1].id, 2);
  assert.equal(items[2].id, 3);
  assert.equal(items[3].id, 4);
  assert.equal(items[0].status, "pending");
  assert.equal(items[1].status, "in_progress");
  assert.equal(items[2].status, "blocked");
  assert.equal(items[2].reason, "waiting for specs");
  assert.equal(items[3].status, "completed");
});

test("single active enforcement: cannot have >1 in_progress tasks", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, createMockContext } = harness;
  const { ctx } = createMockContext();

  const res = await tool.definition.execute("call-2", {
    action: "set",
    items: [
      { text: "Task 1", status: "in_progress" },
      { text: "Task 2", status: "in_progress" },
    ],
  }, undefined, undefined, ctx);

  assert.equal(res.isError, true, "setting >1 in_progress tasks should fail");
});

test("batch transition and blocked reason lifecycle", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, createMockContext, customEntries } = harness;
  const { ctx } = createMockContext();

  // Initial set
  await tool.definition.execute("call-1", {
    action: "set",
    items: [
      { text: "Task 1", status: "in_progress" },
      { text: "Task 2", status: "pending" },
      { text: "Task 3", status: "blocked", reason: "blocked by Task 1" },
    ],
  }, undefined, undefined, ctx);

  // Batch update: Task 1 -> completed, Task 2 -> in_progress, Task 3 -> pending (clear reason)
  const res = await tool.definition.execute("call-2", {
    action: "update",
    updates: [
      { id: 1, status: "completed" },
      { id: 2, status: "in_progress" },
      { id: 3, status: "pending" },
    ],
  }, undefined, undefined, ctx);

  assert.equal(res.isError, undefined, "batch update should succeed: " + JSON.stringify(res));
  const latestItems = customEntries[customEntries.length - 1].data.items;
  assert.equal(latestItems[0].status, "completed");
  assert.equal(latestItems[1].status, "in_progress");
  assert.equal(latestItems[2].status, "pending");
  assert.equal(latestItems[2].reason, undefined, "stale reason cleared when leaving blocked");

  // Setting blocked without reason should fail
  const badRes = await tool.definition.execute("call-3", {
    action: "update",
    updates: [{ id: 2, status: "blocked" }], // no reason!
  }, undefined, undefined, ctx);
  assert.equal(badRes.isError, true, "blocked without reason must fail");
});

test("invalid operations atomic: batch failure leaves state unchanged", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, createMockContext, customEntries } = harness;
  const { ctx } = createMockContext();

  await tool.definition.execute("call-1", {
    action: "set",
    items: [{ text: "Task 1", status: "pending" }],
  }, undefined, undefined, ctx);

  const entriesBefore = customEntries.length;

  // Batch with 1 valid update and 1 invalid update (unknown id 99)
  const res = await tool.definition.execute("call-2", {
    action: "update",
    updates: [
      { id: 1, status: "in_progress" },
      { id: 99, status: "completed" },
    ],
  }, undefined, undefined, ctx);

  assert.equal(res.isError, true, "batch with unknown id should fail");
  assert.equal(customEntries.length, entriesBefore, "no persistence on invalid batch");

  // Verify list still has Task 1 as pending
  const listRes = await tool.definition.execute("call-3", { action: "list" }, undefined, undefined, ctx);
  assert.match(listRes.content[0].text, /pending|待办/i);
  assert.doesNotMatch(listRes.content[0].text, /in_progress|进行中/i);
});

test("duplicate ids in batch updates are rejected", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, createMockContext } = harness;
  const { ctx } = createMockContext();

  await tool.definition.execute("call-1", {
    action: "set",
    items: [{ text: "Task 1", status: "pending" }],
  }, undefined, undefined, ctx);

  const res = await tool.definition.execute("call-2", {
    action: "update",
    updates: [
      { id: 1, text: "New A" },
      { id: 1, text: "New B" },
    ],
  }, undefined, undefined, ctx);

  assert.equal(res.isError, true, "duplicate ids in update batch should fail");
});

test("persistence failure leaves state unchanged", async () => {
  const harness = await createExtensionTestHarness({ appendEntryError: "Disk full" });
  const { tool, createMockContext } = harness;
  const { ctx } = createMockContext();

  const res = await tool.definition.execute("call-1", {
    action: "set",
    items: [{ text: "Task 1" }],
  }, undefined, undefined, ctx);

  assert.equal(res.isError, true, "persistence error should return error");

  const listRes = await tool.definition.execute("call-2", { action: "list" }, undefined, undefined, ctx);
  assert.doesNotMatch(listRes.content[0].text, /Task 1/);
});

test("snapshots and history immutable", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, createMockContext, customEntries } = harness;
  const { ctx } = createMockContext();

  const rawItems = [{ text: "Original Title", status: "pending" }];
  await tool.definition.execute("call-1", { action: "set", items: rawItems }, undefined, undefined, ctx);

  // Mutate raw items after calling set
  rawItems[0].text = "Mutated Outer Title";

  // Check persisted snapshot
  const snapshotItem = customEntries[0].data.items[0];
  assert.equal(snapshotItem.text, "Original Title", "persisted snapshot is immutable");

  // Mutate snapshot item directly
  snapshotItem.text = "Hacked Snapshot";

  // List should still reflect true state
  const listRes = await tool.definition.execute("call-2", { action: "list" }, undefined, undefined, ctx);
  assert.match(listRes.content[0].text, /Original Title/);
  assert.doesNotMatch(listRes.content[0].text, /Hacked Snapshot/);
});

test("branch restoration: session_start restores branch, empty branch clears state, corrupt snapshot handled safely", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, ext, createMockContext } = harness;

  const sessionStartHandlers = ext.handlers.get("session_start") || [];
  assert.ok(sessionStartHandlers.length > 0, "session_start handler registered");

  // 1. Branch with valid snapshot
  const validBranch = [
    {
      type: "custom",
      customType: "pi-todo-state",
      data: {
        version: 1,
        items: [{ id: 1, text: "Branch task", status: "in_progress" }],
      },
    },
  ];

  const mockCtx1 = createMockContext({
    sessionManager: { getBranch: () => validBranch },
  });
  await sessionStartHandlers[0]({}, mockCtx1.ctx);

  const list1 = await tool.definition.execute("call-1", { action: "list" }, undefined, undefined, mockCtx1.ctx);
  assert.match(list1.content[0].text, /Branch task/);

  // 2. Empty branch clears state and hides widget
  const mockCtx2 = createMockContext({
    sessionManager: { getBranch: () => [] },
  });
  await sessionStartHandlers[0]({}, mockCtx2.ctx);
  assert.equal(mockCtx2.getWidgetContent(), undefined, "empty branch clears widget");

  const list2 = await tool.definition.execute("call-2", { action: "list" }, undefined, undefined, mockCtx2.ctx);
  assert.doesNotMatch(list2.content[0].text, /Branch task/);

  // 3. Corrupt latest snapshot warns and empties state
  const corruptBranch = [
    {
      type: "custom",
      customType: "pi-todo-state",
      data: {
        version: 1,
        items: [{ id: "bad", text: "" }], // corrupt item
      },
    },
  ];
  const mockCtx3 = createMockContext({
    sessionManager: { getBranch: () => corruptBranch },
  });
  await sessionStartHandlers[0]({}, mockCtx3.ctx);
  assert.ok(
    mockCtx3.notifications.some(n => n.type === "warning"),
    "warning notification triggered for corrupt snapshot"
  );
  assert.equal(mockCtx3.getWidgetContent(), undefined, "corrupt branch safely clears state/widget");
});

test("UI rendering: widget summary + at most 3 rows, all completed collapses, empty hidden", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, createMockContext } = harness;
  const mock = createMockContext();

  // 1. Empty hidden
  await tool.definition.execute("call-1", { action: "clear" }, undefined, undefined, mock.ctx);
  assert.equal(mock.getWidgetContent(), undefined, "empty state hides widget");

  // 2. All completed collapses to 1 line
  await tool.definition.execute("call-2", {
    action: "set",
    items: [
      { text: "Done 1", status: "completed" },
      { text: "Done 2", status: "completed" },
    ],
  }, undefined, undefined, mock.ctx);

  const completedLines = mock.getWidgetContent();
  assert.ok(Array.isArray(completedLines), "widget lines array");
  assert.equal(completedLines.length, 1, "all completed collapses to 1 summary line");
  assert.match(completedLines[0], /✓/);
  assert.match(completedLines[0], /2\/2/);
  assert.match(completedLines[0], /全部完成/);

  // 3. Multiple tasks: 1 summary line + at most 3 rows, priority blocked/in_progress/pending
  await tool.definition.execute("call-3", {
    action: "set",
    items: [
      { text: "Pending 1", status: "pending" },
      { text: "Pending 2", status: "pending" },
      { text: "Blocked 1", status: "blocked", reason: "waiting" },
      { text: "In Progress 1", status: "in_progress" },
      { text: "Pending 3", status: "pending" },
    ],
  }, undefined, undefined, mock.ctx);

  const mixedLines = mock.getWidgetContent();
  assert.equal(mixedLines.length, 4, "1 summary + 3 detail rows");
  assert.match(mixedLines[0], /待办 0\/5/, "summary shows completed/total counts");
  assert.match(mixedLines[0], /还有 2 项/, "summary reports hidden unfinished tasks");
  // Row 1 should be Blocked 1 (with reason and glyph)
  assert.match(mixedLines[1], /✖ #3 Blocked 1/);
  assert.match(mixedLines[1], /waiting/);
  // Row 2 should be In Progress 1
  assert.match(mixedLines[2], /◐ #4 In Progress 1/);
  // Row 3 should be Pending 1
  assert.match(mixedLines[3], /○ #1 Pending 1/);
});

test("sanitization: control characters and newlines stripped, width truncated safely", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, createMockContext } = harness;
  const mock = createMockContext();

  await tool.definition.execute("call-1", {
    action: "set",
    items: [
      { text: "Line 1\nLine 2\r\x1b[31mRed\x1b[0m\tEnd", status: "in_progress" },
    ],
  }, undefined, undefined, mock.ctx);

  const lines = mock.getWidgetContent();
  assert.ok(lines.length >= 2);
  const detail = lines[1];
  assert.doesNotMatch(detail, /[\n\r\x1b]/, "no raw control characters or ANSI leaks in sanitized line");
});

test("/todos command opens modal select with progress title, glyphs, ids and blocked reasons", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, todosCmd, createMockContext } = harness;
  const mock = createMockContext();

  await tool.definition.execute("call-1", {
    action: "set",
    items: [
      { text: "Task 1", status: "blocked", reason: "Need API key" },
      { text: "Task 2", status: "in_progress" },
    ],
  }, undefined, undefined, mock.ctx);

  await todosCmd.handler("", mock.ctx);
  const { selectedTitle, selectedOptions } = mock.getSelectState();
  assert.ok(selectedTitle, "select title presented");
  assert.match(selectedTitle, /0\/2/, "title shows progress counts");
  assert.match(selectedTitle, /ESC/, "title keeps the escape hint");
  assert.ok(selectedOptions.length >= 2, "options list presented");
  assert.match(selectedOptions[0], /✖ #1 Task 1/);
  assert.match(selectedOptions[0], /Need API key/);
  assert.match(selectedOptions[1], /◐ #2 Task 2/);
});

test("context handler: appends latest ephemeral custom message with unfinished tasks, filters old ones", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, ext, createMockContext } = harness;
  const mock = createMockContext();

  const contextHandlers = ext.handlers.get("context") || [];
  assert.ok(contextHandlers.length > 0, "context handler registered");

  // 1. With unfinished tasks
  await tool.definition.execute("call-1", {
    action: "set",
    items: [
      { text: "Task 1", status: "pending" },
      { text: "Task 2", status: "in_progress" },
    ],
  }, undefined, undefined, mock.ctx);

  const existingMessages = [
    { role: "user", content: "Hello" },
    { role: "custom", customType: "pi-todo-context", content: "Old snapshot", display: false, timestamp: 1 },
    { role: "assistant", content: "Hi" },
  ];

  const res1 = await contextHandlers[0]({ type: "context", messages: existingMessages }, mock.ctx);
  assert.ok(res1?.messages, "context returned messages");
  // Must remove old pi-todo-context message
  const todoMessages = res1.messages.filter(m => m.customType === "pi-todo-context");
  assert.equal(todoMessages.length, 1, "exactly one ephemeral custom message");
  assert.equal(todoMessages[0].display, false);
  assert.match(todoMessages[0].content, /Task 1/);
  assert.match(todoMessages[0].content, /Task 2/);
  // Other messages untouched
  assert.equal(res1.messages[0].role, "user");
  assert.equal(res1.messages[1].role, "assistant");

  // 2. When all completed, no custom message injected
  await tool.definition.execute("call-2", {
    action: "update",
    updates: [
      { id: 1, status: "completed" },
      { id: 2, status: "completed" },
    ],
  }, undefined, undefined, mock.ctx);

  const res2 = await contextHandlers[0]({ type: "context", messages: existingMessages }, mock.ctx);
  const todoMessages2 = res2.messages.filter(m => m.customType === "pi-todo-context");
  assert.equal(todoMessages2.length, 0, "no context message when all tasks are completed");
});

test("regression: {action: 'set'} requires explicit items array and preserves seeded state on malformed inputs", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, createMockContext, customEntries } = harness;
  const mock = createMockContext();

  // 1. Seed an existing valid task
  const seedRes = await tool.definition.execute("seed-1", {
    action: "set",
    items: [{ text: "Seeded Task", status: "pending" }],
  }, undefined, undefined, mock.ctx);
  assert.equal(seedRes.isError, undefined);
  assert.equal(customEntries.length, 1);

  // Helper to verify state remains exactly the seeded task
  async function assertStatePreserved(callName) {
    assert.equal(customEntries.length, 1, `${callName}: entries count must remain 1`);
    const listRes = await tool.definition.execute("check-" + callName, { action: "list" }, undefined, undefined, mock.ctx);
    assert.match(listRes.content[0].text, /Seeded Task/);
    assert.equal(listRes.structuredContent?.items?.length, 1);
  }

  // 2. {action: 'set'} without items must fail and NOT erase tasks
  const resNoItems = await tool.definition.execute("bad-1", {
    action: "set",
  }, undefined, undefined, mock.ctx);
  assert.equal(resNoItems.isError, true, "set without items array must fail");
  await assertStatePreserved("bad-1");

  // 3. Malformed status: empty string, null, false
  for (const badStatus of ["", null, false, "unknown_status"]) {
    const resBadStatus = await tool.definition.execute("bad-status-" + String(badStatus), {
      action: "set",
      items: [{ text: "New Task", status: badStatus }],
    }, undefined, undefined, mock.ctx);
    assert.equal(resBadStatus.isError, true, `status '${String(badStatus)}' must fail`);
    await assertStatePreserved("bad-status-" + String(badStatus));
  }

  // 4. Malformed reason on nonblocked tasks in 'set'
  for (const badReason of [123, "   ", "r".repeat(241)]) {
    const resBadReason = await tool.definition.execute("bad-reason-set", {
      action: "set",
      items: [{ text: "Pending Task", status: "pending", reason: badReason }],
    }, undefined, undefined, mock.ctx);
    assert.equal(resBadReason.isError, true, `invalid reason in set must fail: ${typeof badReason}`);
    await assertStatePreserved("bad-reason-set");
  }

  // 5. Malformed reason on 'update'
  for (const badReason of [123, "   ", "r".repeat(241)]) {
    const resBadReasonUpdate = await tool.definition.execute("bad-reason-update", {
      action: "update",
      updates: [{ id: 1, reason: badReason }],
    }, undefined, undefined, mock.ctx);
    assert.equal(resBadReasonUpdate.isError, true, `invalid reason in update must fail: ${typeof badReason}`);
    await assertStatePreserved("bad-reason-update");
  }
});

test("regression: outputSchema defined and structuredContent returned for success and error", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, createMockContext } = harness;
  const mock = createMockContext();

  // outputSchema must be defined on tool definition
  assert.ok(tool.definition.outputSchema, "tool must define outputSchema");
  assert.equal(tool.definition.outputSchema.type, "object");
  assert.ok(tool.definition.outputSchema.properties?.items, "outputSchema has items");

  // 1. Success response has matching structuredContent
  const setRes = await tool.definition.execute("call-1", {
    action: "set",
    items: [{ text: "Structured Item 1", status: "pending" }],
  }, undefined, undefined, mock.ctx);
  assert.equal(setRes.isError, undefined);
  assert.ok(setRes.structuredContent, "structuredContent must be returned on success");
  assert.equal(setRes.structuredContent.items.length, 1);
  assert.equal(setRes.structuredContent.items[0].id, 1);
  assert.equal(setRes.structuredContent.items[0].text, "Structured Item 1");
  assert.equal(setRes.structuredContent.items[0].status, "pending");

  // 2. Error response has matching structuredContent with error property
  const errRes = await tool.definition.execute("call-2", {
    action: "update",
    updates: [{ id: 999, status: "completed" }],
  }, undefined, undefined, mock.ctx);
  assert.equal(errRes.isError, true);
  assert.ok(errRes.structuredContent, "structuredContent must be returned on error");
  assert.ok(errRes.structuredContent.error, "error string present in structuredContent");
  assert.equal(errRes.structuredContent.items.length, 1, "items array preserved in structuredContent");
});

test("regression: widget factory component render(width) handles CJK/emoji at 12/30 cols, resize and sanitization", async () => {
  const { getHostRoot } = await import("./harness.mjs");
  const tui = await import(getHostRoot() + "/@earendil-works/pi-tui/dist/index.js");
  const visibleWidth = tui.visibleWidth;

  const harness = await createExtensionTestHarness();
  const { tool, createMockContext } = harness;
  const mock = createMockContext();

  // Untrusted text containing C1 controls, OSC, DCS, bidi, collapsed newlines, CJK and emoji
  const untrustedText = "待办任务\u0084\u009b\x1b]0;BadOSC\x07\x1bPq\"1;1;100\x1b\\Line1\r\n\tLine2\u202Ereversed\u202C🚀🎉";

  await tool.definition.execute("call-1", {
    action: "set",
    items: [
      { text: untrustedText, status: "in_progress" },
      { text: "待办事项B：测试很长很长的中文描述文本超过宽度限制", status: "pending" },
    ],
  }, undefined, undefined, mock.ctx);

  const rawWidget = mock.getWidgetRaw();
  assert.equal(typeof rawWidget, "function", "widget must be registered as a factory function");

  const comp = mock.getWidgetComponent();
  assert.ok(comp, "factory returns component");
  assert.equal(typeof comp.render, "function", "component has render(width)");
  assert.equal(typeof comp.invalidate, "function", "component implements the host invalidation contract");
  assert.doesNotThrow(() => comp.invalidate());

  const stripTerminalSequences = tui.stripTerminalSequences;

  // 1. Render at 12 cols
  const lines12 = comp.render(12);
  assert.ok(lines12.length > 0);
  for (const line of lines12) {
    const vw = visibleWidth(line);
    assert.ok(vw <= 12, `line width ${vw} exceeds 12 cols: "${line}"`);
    // No raw unescaped C0/C1 control characters, bidi or leaked OSC
    const stripped = stripTerminalSequences(line);
    assert.doesNotMatch(stripped, /[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
    assert.doesNotMatch(line, /[\r\n\t]/);
    assert.doesNotMatch(line, /BadOSC/);
  }

  // 2. Resize with same component instance to 30 cols
  const lines30 = comp.render(30);
  assert.ok(lines30.length > 0);
  for (const line of lines30) {
    const vw = visibleWidth(line);
    assert.ok(vw <= 30, `line width ${vw} exceeds 30 cols: "${line}"`);
    const stripped = stripTerminalSequences(line);
    assert.doesNotMatch(stripped, /[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
    assert.doesNotMatch(line, /[\r\n\t]/);
    assert.doesNotMatch(line, /BadOSC/);
  }
});

test("UI rendering: themed widget uses semantic colors and progress bar, and drops the bar when narrow", async () => {
  const { getHostRoot } = await import("./harness.mjs");
  const tui = await import(getHostRoot() + "/@earendil-works/pi-tui/dist/index.js");

  const harness = await createExtensionTestHarness();
  const { tool, createMockContext } = harness;
  const mock = createMockContext();

  await tool.definition.execute("call-1", {
    action: "set",
    items: [
      { text: "阻塞任务", status: "blocked", reason: "等待上游" },
      { text: "进行中任务", status: "in_progress" },
      { text: "待办任务", status: "pending" },
      { text: "已完成任务", status: "completed" },
    ],
  }, undefined, undefined, mock.ctx);

  const theme = createThemeStub();
  const comp = mock.getWidgetComponent(theme);
  assert.ok(comp, "factory returns component for a themed host");

  const lines = comp.render(60);
  assert.equal(lines.length, 4, "header + 3 unfinished rows");
  for (const line of lines) {
    assert.ok(tui.visibleWidth(line) <= 60, `line width exceeds 60 cols: ${JSON.stringify(line)}`);
  }

  assert.match(lines[0], /\x1b\[/, "header carries ANSI styling");
  assert.match(lines[0], /█/, "progress bar rendered when width allows");
  assert.ok(theme.tokens.includes("accent"), "accent token used for counts");
  assert.ok(theme.tokens.includes("success"), "success token used for the filled bar");
  assert.ok(theme.tokens.includes("warning"), "warning token used for the blocked task");
  assert.ok(theme.tokens.includes("dim") || theme.tokens.includes("muted"), "secondary tokens used");

  const plain = lines.map((line) => tui.stripTerminalSequences(line));
  assert.match(plain[0], /待办 1\/4/);
  assert.match(plain[1], /✖ #1 阻塞任务 · 等待上游/);
  assert.match(plain[2], /◐ #2 进行中任务/);
  assert.match(plain[3], /○ #3 待办任务/);

  // Narrow terminals drop the bar and stay within bounds without leaking escapes.
  const narrow = comp.render(12);
  assert.ok(narrow.length > 0);
  for (const line of narrow) {
    assert.ok(tui.visibleWidth(line) <= 12, `narrow line exceeds 12 cols: ${JSON.stringify(line)}`);
    assert.doesNotMatch(tui.stripTerminalSequences(line), /[\x00-\x1f\x7f-\x9f]/);
  }
  assert.doesNotMatch(narrow[0], /█/, "progress bar dropped at narrow widths");
});

test("regression: simulated session_start reasons and invalid latest snapshot does not fall back", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, ext, createMockContext } = harness;

  const sessionStartHandlers = ext.handlers.get("session_start") || [];
  assert.ok(sessionStartHandlers.length > 0, "session_start handler registered");

  // 1. Test simulated reasons: "new", "reload", "resume", "fork"
  for (const reason of ["new", "reload", "resume", "fork"]) {
    const branch = [
      {
        type: "custom",
        customType: "pi-todo-state",
        data: {
          version: 1,
          items: [{ id: 1, text: `Task for ${reason}`, status: "pending" }],
        },
      },
    ];
    const mock = createMockContext({
      sessionManager: { getBranch: () => branch },
    });
    await sessionStartHandlers[0]({ type: "session_start", reason }, mock.ctx);
    const listRes = await tool.definition.execute("check-" + reason, { action: "list" }, undefined, undefined, mock.ctx);
    assert.match(listRes.content[0].text, new RegExp(`Task for ${reason}`));
  }

  // 2. Branch has older valid snapshot, followed by corrupt latest snapshot:
  // MUST NOT fall back to older valid snapshot; state must be empty!
  const branchWithCorruptLatest = [
    {
      type: "custom",
      customType: "pi-todo-state",
      data: {
        version: 1,
        items: [{ id: 1, text: "Old valid task", status: "pending" }],
      },
    },
    {
      type: "custom",
      customType: "pi-todo-state",
      data: {
        version: 1,
        items: [{ id: "bad_id", text: 12345 }], // corrupt!
      },
    },
  ];

  const corruptMock = createMockContext({
    sessionManager: { getBranch: () => branchWithCorruptLatest },
  });
  await sessionStartHandlers[0]({ type: "session_start", reason: "resume" }, corruptMock.ctx);
  assert.ok(
    corruptMock.notifications.some((n) => n.type === "warning"),
    "warning notification triggered"
  );
  const listAfterCorrupt = await tool.definition.execute("check-corrupt", { action: "list" }, undefined, undefined, corruptMock.ctx);
  assert.doesNotMatch(listAfterCorrupt.content[0].text, /Old valid task/, "must not fall back to previous valid snapshot");
  assert.match(listAfterCorrupt.content[0].text, /empty|暂无/i);
});
