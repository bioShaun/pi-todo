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

test("UI rendering: long plans show at most six tasks, prioritizing active work in id order", async () => {
  const h = await createExtensionTestHarness();
  const mock = h.createMockContext();
  const run = params => h.tool.definition.execute("ui", params, undefined, undefined, mock.ctx);
  await run({ action: "clear" });
  assert.equal(mock.getWidgetContent(), undefined);
  await run({action: "set", items: Array.from({length: 12}, (_, i) => ({text: `Task ${i+1}`, status: "completed"}))});
  let lines = mock.getWidgetContent(120);
  assert.match(lines[0], /12\/12 全部完成/);
  assert.equal(lines.filter(l => /✓/.test(l)).length, 6);
  assert.match(lines[1], /#1  Task 1/);
  assert.match(lines.at(-1), /另有 6 项.*\/todos/);
  await run({action: "update", updates: [{id: 5, status: "blocked", reason: "等待接口"}]});
  lines = mock.getWidgetContent(120);
  assert.match(lines[0], /11\/12 完成 · 1 项受阻/);
  assert.match(lines[5], /✖ #5  Task 5/);
  assert.match(lines[6], /└ 等待接口/);
  assert.equal(lines.filter(l => /#\d+/.test(l)).length, 6);
  await run({action: "update", updates: [
    {id: 12, status: "in_progress"},
    ...[7, 8, 9, 10, 11].map(id => ({id, status: "pending"})),
  ]});
  lines = mock.getWidgetContent(120);
  assert.deepEqual(lines.flatMap(l => [...l.matchAll(/#(\d+)/g)].map(m => Number(m[1]))), [5, 7, 8, 9, 10, 12]);
  assert.match(lines.at(-1), /另有 6 项.*\/todos/);
  const listed = await run({action: "list"});
  assert.equal(listed.structuredContent.items.length, 12);
  await run({action: "set", items: Array.from({length: 6}, (_, i) => ({text: `Short ${i}`}))});
  lines = mock.getWidgetContent(120);
  assert.equal(lines.filter(l => /#\d+/.test(l)).length, 6);
  assert.doesNotMatch(lines.at(-1), /另有/);
});

test("Alt+T and /todos toggle only collapse presentation; updates preserve it and new plans reset it", async () => {
  const h = await createExtensionTestHarness();
  const mock = h.createMockContext();
  const shortcut = h.ext.shortcuts.get("alt+t");
  assert.ok(shortcut, "Alt+T fold shortcut must be registered");
  const run = params => h.tool.definition.execute("ui", params, undefined, undefined, mock.ctx);
  await shortcut.handler(mock.ctx);
  assert.match(mock.notifications.at(-1).msg, /暂无/);
  await run({action:"set",items:[{text:"A",status:"in_progress"},{text:"B",status:"pending"}]});
  const persisted = h.customEntries.length;
  await shortcut.handler(mock.ctx);
  assert.equal(mock.getWidgetContent().length, 1);
  assert.match(mock.getWidgetContent()[0], /▸.*0\/2.*展开/);
  assert.equal(h.customEntries.length, persisted);
  await run({action:"update",updates:[{id:1,status:"completed"},{id:2,status:"blocked",reason:"waiting"}]});
  assert.equal(mock.getWidgetContent().length, 1);
  assert.match(mock.getWidgetContent()[0], /1\/2 完成 · 1 项受阻/);
  await run({action:"list"});
  assert.equal(mock.getWidgetContent().length, 1);
  await run({action:"set",items:[{text:"",status:"pending"}]});
  assert.equal(mock.getWidgetContent().length, 1, "failed set must preserve collapse");
  await h.todosCmd.handler("toggle",mock.ctx);
  assert.ok(mock.getWidgetContent().length > 1);
  await shortcut.handler(mock.ctx);
  await run({action:"set",items:[{text:"New plan",status:"completed"}]});
  assert.ok(mock.getWidgetContent().length > 1, "new completed plan is expanded");
  await shortcut.handler(mock.ctx);
  await h.ext.handlers.get("session_tree")[0]({},mock.ctx);
  assert.ok(mock.getWidgetContent().length > 1, "branch restore starts expanded");
  await shortcut.handler(mock.ctx);
  await h.ext.handlers.get("session_start")[0]({},mock.ctx);
  assert.ok(mock.getWidgetContent().length > 1, "new session starts expanded");
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

test("/todos details wrap full text, scroll and close without changing the plan", async () => {
  const h = await createExtensionTestHarness();
  const mock = h.createMockContext();
  await h.tool.definition.execute("details", {action:"set",items:[
    {text:"长任务标题需要完整查看".repeat(5),status:"blocked",reason:"等待上游接口恢复".repeat(8)},
    ...Array.from({length:10},(_,i)=>({text:`完成步骤 ${i+1}`,status:"completed"}))
  ]},undefined,undefined,mock.ctx);
  await h.todosCmd.handler("",mock.ctx);
  const detail = mock.getDetails();
  assert.ok(detail.component, "details use a custom wrapping view");
  let lines = detail.component.render(40);
  assert.ok(lines.length <= 20);
  assert.match(lines[0], /10\/11/);
  assert.match(lines.at(-1), /Esc/);
  assert.doesNotMatch(lines.slice(1, -1).join(""), /\.\.\./, "body wraps rather than truncating at a normal width");
  const top = lines.join("\n");
  detail.component.handleInput("\x1b[6~");
  lines = detail.component.render(40);
  assert.notEqual(lines.join("\n"), top, "page down reveals remaining text");
  detail.component.handleInput("\x1b[F");
  assert.match(detail.component.render(40).join("\n"), /完成步骤 10/);
  detail.terminal.rows=8;
  assert.ok(detail.component.render(25).length <= 8, "resize clamps viewport");
  detail.component.handleInput("\x1b[H");
  assert.match(detail.component.render(40).join("\n"), /长任务标题/);
  detail.component.handleInput("\x1b");
  assert.equal(mock.getDetails().closed,true);
  assert.equal(h.customEntries.length,1, "reading details never changes state");
});

test("context handler removed: extension does not register context hook, uses persistent custom messages via sendMessage", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, ext, sentMessages, createMockContext } = harness;
  const mock = createMockContext();

  const contextHandlers = ext.handlers.get("context") || [];
  assert.equal(contextHandlers.length, 0, "context hook must not be registered");

  // 1. With unfinished tasks, tool execution appends persistent custom message
  await tool.definition.execute("call-1", {
    action: "set",
    items: [
      { text: "Task 1", status: "pending" },
      { text: "Task 2", status: "in_progress" },
    ],
  }, undefined, undefined, mock.ctx);

  assert.equal(sentMessages.length, 1, "exactly one custom message sent");
  assert.equal(sentMessages[0].message.customType, "pi-todo-context");
  assert.equal(sentMessages[0].message.display, false);
  assert.equal(sentMessages[0].options?.triggerTurn, false);
  const parsed1 = JSON.parse(sentMessages[0].message.content);
  assert.equal(parsed1.todos.length, 2);
  assert.equal(parsed1.todos[0].text, "Task 1");

  // 2. When all completed, appends snapshot with empty todos
  await tool.definition.execute("call-2", {
    action: "update",
    updates: [
      { id: 1, status: "completed" },
      { id: 2, status: "completed" },
    ],
  }, undefined, undefined, mock.ctx);

  assert.equal(sentMessages.length, 2);
  const parsed2 = JSON.parse(sentMessages[1].message.content);
  assert.deepEqual(parsed2.todos, [], "todos snapshot is empty array when all tasks are completed");
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
  for (const badReason of [123, null, "r".repeat(241)]) {
    const resBadReason = await tool.definition.execute("bad-reason-set", {
      action: "set",
      items: [{ text: "Pending Task", status: "pending", reason: badReason }],
    }, undefined, undefined, mock.ctx);
    assert.equal(resBadReason.isError, true, `invalid reason in set must fail: ${typeof badReason}`);
    await assertStatePreserved("bad-reason-set");
  }

  // 5. Malformed reason on 'update'
  for (const badReason of [123, null, "r".repeat(241)]) {
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

test("reported Unicode set payload normalizes reasons in every output", async () => {
  const h = await createExtensionTestHarness();
  const { customEntries, sentMessages } = h;
  const { ctx } = h.createMockContext();
  const res = await h.tool.definition.execute("reported-payload", {
    action: "set", updates: [], items: [
      { reason: "", status: "in_progress", text: "定位 BLAST 工具任务 UnicodeEncodeError 的根因与触发链路" },
      { reason: "", status: "pending", text: "修复编码契约并补充对应回归验证" },
      { reason: "", status: "pending", text: "检查差异、验证结果并提交修复" },
    ],
  }, undefined, undefined, ctx);
  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent.items.length, 3);
  assert.ok(res.structuredContent.items.every(item => !Object.hasOwn(item, "reason")));
  assert.ok(customEntries.at(-1).data.items.every(item => !Object.hasOwn(item, "reason")));
  assert.ok(JSON.parse(sentMessages.at(-1).message.content).todos.every(item => !Object.hasOwn(item, "reason")));
});

test("nonblocked set and update normalize blank and nonblank reasons", async () => {
  for (const status of [undefined, "pending", "in_progress", "completed"]) {
    for (const reason of ["", " \t ", "valid reason"]) {
      const h = await createExtensionTestHarness();
      const { customEntries, sentMessages } = h;
      const { ctx } = h.createMockContext();
      const items = [{ text: "first", ...(status ? { status } : {}), reason }];
      if (status === "in_progress") items.push({ text: "second", status: "pending", reason });
      const set = await h.tool.definition.execute("table-set", { action: "set", items }, undefined, undefined, ctx);
      assert.equal(set.isError, undefined, `set status=${status} reason=${JSON.stringify(reason)}`);
      assert.ok(set.structuredContent.items.every(item => !Object.hasOwn(item, "reason")));
      assert.ok(customEntries.at(-1).data.items.every(item => !Object.hasOwn(item, "reason")));
      assert.ok(JSON.parse(sentMessages.at(-1).message.content).todos.every(item => !Object.hasOwn(item, "reason")));
      for (const updateStatus of [undefined, status]) {
        const update = await h.tool.definition.execute("table-update", { action: "update", updates: [
          { id: 1, ...(updateStatus ? { status: updateStatus } : {}), reason },
        ] }, undefined, undefined, ctx);
        assert.equal(update.isError, undefined, `update status=${updateStatus} reason=${JSON.stringify(reason)}`);
        assert.ok(update.structuredContent.items.every(item => !Object.hasOwn(item, "reason")));
        assert.ok(customEntries.at(-1).data.items.every(item => !Object.hasOwn(item, "reason")));
        assert.ok(JSON.parse(sentMessages.at(-1).message.content).todos.every(item => !Object.hasOwn(item, "reason")));
      }
    }
  }
});

test("blocked reasons are required, preserved, and atomically validated", async () => {
  const h = await createExtensionTestHarness();
  const { customEntries, sentMessages } = h;
  const { ctx } = h.createMockContext();
  const run = (call, params) => h.tool.definition.execute(call, params, undefined, undefined, ctx);
  const seed = await run("seed", { action: "set", items: [
    { text: "blocked", status: "blocked", reason: "waiting" }, { text: "pending", status: "pending" },
  ] });
  assert.equal(seed.isError, undefined);
  const preserved = await run("preserve", { action: "update", updates: [{ id: 1 }] });
  assert.equal(preserved.structuredContent.items[0].reason, "waiting");
  for (const reason of ["", " \t "]) {
    const badExisting = await run("bad-existing", { action: "update", updates: [{ id: 1, reason }] });
    assert.equal(badExisting.isError, true);
    assert.match(badExisting.structuredContent.error, /blank/i);
    const badSet = await run("bad-set", { action: "set", items: [
      { text: "valid nonblocked", status: "pending", reason: "" }, { text: "invalid", status: "blocked", reason },
    ] });
    assert.equal(badSet.isError, true);
    assert.match(badSet.structuredContent.error, /blank/i);
  }
  for (const reason of [undefined, "", " \t "]) {
    const setItem = { text: "blocked", status: "blocked" };
    if (reason !== undefined) setItem.reason = reason;
    const badSet = await run("missing-blocked-set", { action: "set", items: [setItem] });
    assert.equal(badSet.isError, true);
    assert.match(badSet.structuredContent.error, /reason|blank/i);
    const badTransition = await run("missing-blocked-update", { action: "update", updates: [{ id: 2, status: "blocked", ...(reason === undefined ? {} : { reason }) }] });
    assert.equal(badTransition.isError, true);
    assert.match(badTransition.structuredContent.error, /reason|blank/i);
  }
  const before = await run("before", { action: "list" });
  const entryCount = customEntries.length;
  const sentCount = sentMessages.length;
  const failedBatch = await run("atomic-invalid", { action: "update", updates: [
    { id: 1, status: "completed", reason: "" }, { id: 2, status: "blocked", reason: " " },
  ] });
  assert.equal(failedBatch.isError, true);
  assert.match(failedBatch.structuredContent.error, /blank/i);
  assert.deepEqual(failedBatch.structuredContent.items, before.structuredContent.items);
  assert.equal(customEntries.length, entryCount);
  assert.equal(sentMessages.length, sentCount);
  const cleared = await run("clear-reason", { action: "update", updates: [{ id: 1, status: "pending", reason: "" }] });
  assert.equal(cleared.isError, undefined);
  assert.equal(Object.hasOwn(cleared.structuredContent.items[0], "reason"), false);
});

test("session_start restores normalized nonblocked reasons and rejects invalid blocked reasons", async () => {
  const h = await createExtensionTestHarness();
  const start = h.ext.handlers.get("session_start")[0];
  for (const reason of ["", " \t ", "valid reason"]) {
    const branch = [{ type: "custom", customType: "pi-todo-state", data: { version: 1, items: [
      { id: 1, text: "restored", status: "pending", reason },
    ] } }];
    const mock = h.createMockContext({ sessionManager: { getBranch: () => branch } });
    await start({ type: "session_start", reason: "resume" }, mock.ctx);
    const res = await h.tool.definition.execute("restored", { action: "list" }, undefined, undefined, mock.ctx);
    assert.equal(res.structuredContent.items.length, 1);
    assert.equal(Object.hasOwn(res.structuredContent.items[0], "reason"), false);
    assert.equal(mock.notifications.some(n => n.type === "warning"), false);
  }
  for (const reason of [undefined, "", " \t ", 123, null]) {
    const item = { id: 1, text: "invalid blocked", status: "blocked" };
    if (reason !== undefined) item.reason = reason;
    const branch = [{ type: "custom", customType: "pi-todo-state", data: { version: 1, items: [item] } }];
    const mock = h.createMockContext({ sessionManager: { getBranch: () => branch } });
    await start({ type: "session_start", reason: "resume" }, mock.ctx);
    const res = await h.tool.definition.execute("rejected-restore", { action: "list" }, undefined, undefined, mock.ctx);
    assert.equal(res.structuredContent.items.length, 0);
    const warning = mock.notifications.find(n => n.type === "warning");
    assert.ok(warning, `expected warning for reason=${JSON.stringify(reason)}`);
    if (reason === undefined) {
      assert.match(warning.msg, /missing non-blank reason/i);
    } else if (typeof reason === "string") {
      assert.match(warning.msg, /invalid reason: Blocked reason cannot be blank/i);
    } else {
      assert.match(warning.msg, /invalid reason: Blocked reason must be a string/i);
    }
  }
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

test("UI rendering: themed widget uses semantic colors and keeps the header text-only", async () => {
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
  assert.equal(lines.length, 7, "header + tasks + reason + details hint");
  for (const line of lines) {
    assert.ok(tui.visibleWidth(line) <= 60, `line width exceeds 60 cols: ${JSON.stringify(line)}`);
  }

  assert.match(lines[0], /\x1b\[/, "header carries ANSI styling");
  assert.ok(theme.tokens.includes("accent"), "accent token used for counts");
  assert.ok(theme.tokens.includes("warning"), "warning token used for the blocked task");
  assert.ok(theme.tokens.includes("success"), "success token used for the completed glyph");
  assert.ok(theme.tokens.includes("dim") || theme.tokens.includes("muted"), "secondary tokens used");

  const plain = lines.map((line) => tui.stripTerminalSequences(line));
  assert.match(plain[0], /待办 1\/4 完成 · 1 项受阻/);
  assert.match(plain[1], /✖ #1 阻塞任务/);
  assert.match(plain[2], /└ 等待上游/);
  assert.match(plain[3], /◐ #2 进行中任务/);
  assert.match(plain[4], /○ #3 待办任务/);
  assert.match(plain[5], /✓ #4 已完成任务/);

  // Narrow terminals stay within bounds without leaking escapes.
  const narrow = comp.render(12);
  assert.ok(narrow.length > 0);
  for (const line of narrow) {
    assert.ok(tui.visibleWidth(line) <= 12, `narrow line exceeds 12 cols: ${JSON.stringify(line)}`);
    assert.doesNotMatch(tui.stripTerminalSequences(line), /[\x00-\x1f\x7f-\x9f]/);
  }
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
