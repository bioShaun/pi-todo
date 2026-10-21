import test from "node:test";
import assert from "node:assert/strict";
import { createExtensionTestHarness } from "./harness.mjs";
import { MAX_ITEMS, MAX_TEXT, MAX_REASON } from "../state.ts";

test("boundaries: MAX_ITEMS, MAX_TEXT, MAX_REASON enforcement", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, createMockContext } = harness;
  const { ctx } = createMockContext();

  // 1. Text length boundary
  const validText = "a".repeat(MAX_TEXT);
  const tooLongText = "a".repeat(MAX_TEXT + 1);

  const resValidText = await tool.definition.execute("call-1", {
    action: "set",
    items: [{ text: validText }],
  }, undefined, undefined, ctx);
  assert.equal(resValidText.isError, undefined, "160 chars text should succeed");

  const resTooLongText = await tool.definition.execute("call-2", {
    action: "set",
    items: [{ text: tooLongText }],
  }, undefined, undefined, ctx);
  assert.equal(resTooLongText.isError, true, "161 chars text should fail");

  // 2. Reason length boundary
  const validReason = "r".repeat(MAX_REASON);
  const tooLongReason = "r".repeat(MAX_REASON + 1);

  const resValidReason = await tool.definition.execute("call-3", {
    action: "set",
    items: [{ text: "Blocked task", status: "blocked", reason: validReason }],
  }, undefined, undefined, ctx);
  assert.equal(resValidReason.isError, undefined, "240 chars reason should succeed");

  const resTooLongReason = await tool.definition.execute("call-4", {
    action: "set",
    items: [{ text: "Blocked task", status: "blocked", reason: tooLongReason }],
  }, undefined, undefined, ctx);
  assert.equal(resTooLongReason.isError, true, "241 chars reason should fail");

  // 3. MAX_ITEMS boundary
  const items20 = Array.from({ length: MAX_ITEMS }, (_, i) => ({ text: `Task ${i + 1}` }));
  const res20 = await tool.definition.execute("call-5", {
    action: "set",
    items: items20,
  }, undefined, undefined, ctx);
  assert.equal(res20.isError, undefined, "20 items should succeed");

  const items21 = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ text: `Task ${i + 1}` }));
  const res21 = await tool.definition.execute("call-6", {
    action: "set",
    items: items21,
  }, undefined, undefined, ctx);
  assert.equal(res21.isError, true, "21 items should fail");
});

test("validation: blank text and whitespace reason rejection", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, createMockContext } = harness;
  const { ctx } = createMockContext();

  const resBlankText = await tool.definition.execute("call-1", {
    action: "set",
    items: [{ text: "   \t  \n " }],
  }, undefined, undefined, ctx);
  assert.equal(resBlankText.isError, true, "whitespace-only title rejected");

  const resBlankReason = await tool.definition.execute("call-2", {
    action: "set",
    items: [{ text: "Valid title", status: "blocked", reason: "   " }],
  }, undefined, undefined, ctx);
  assert.equal(resBlankReason.isError, true, "whitespace-only reason rejected");
});

test("snapshot restore reports all independent validation errors at once", async () => {
  const harness = await createExtensionTestHarness();
  const branch = [{
    type: "custom",
    customType: "pi-todo-state",
    data: {
      version: 1,
      items: [
        { id: 1, text: "", status: "pending" },
        { id: 2, text: "blocked item", status: "blocked" },
        { id: 3, text: "bad status", status: "unknown" },
      ],
    },
  }];
  const mock = harness.createMockContext({ sessionManager: { getBranch: () => branch } });
  await harness.ext.handlers.get("session_start")[0]({ type: "session_start", reason: "resume" }, mock.ctx);

  const warning = mock.notifications.find(n => n.type === "warning");
  assert.ok(warning, "invalid snapshot must warn");
  assert.match(warning.msg, /3 errors/);
  assert.match(warning.msg, /Item 1: Task text cannot be blank/);
  assert.match(warning.msg, /Item 2 is blocked but missing non-blank reason/);
  assert.match(warning.msg, /Item 3 has invalid status/);
  const result = await harness.tool.definition.execute("list", { action: "list" }, undefined, undefined, mock.ctx);
  assert.deepEqual(result.structuredContent.items, [], "invalid snapshot resets state");
});

test("session_tree handler: restores state when branch switches", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, ext, createMockContext } = harness;

  const sessionTreeHandlers = ext.handlers.get("session_tree") || [];
  assert.ok(sessionTreeHandlers.length > 0, "session_tree handler registered");

  const branchA = [
    {
      type: "custom",
      customType: "pi-todo-state",
      data: {
        version: 1,
        items: [{ id: 1, text: "Branch A task", status: "pending" }],
      },
    },
  ];

  const mockCtx = createMockContext({
    sessionManager: { getBranch: () => branchA },
  });

  await sessionTreeHandlers[0]({}, mockCtx.ctx);
  const resA = await tool.definition.execute("call-1", { action: "list" }, undefined, undefined, mockCtx.ctx);
  assert.match(resA.content[0].text, /Branch A task/);

  // Switch branch to branch B
  const branchB = [
    {
      type: "custom",
      customType: "pi-todo-state",
      data: {
        version: 1,
        items: [{ id: 1, text: "Branch B task", status: "in_progress" }],
      },
    },
  ];
  mockCtx.ctx.sessionManager.getBranch = () => branchB;

  await sessionTreeHandlers[0]({}, mockCtx.ctx);
  const resB = await tool.definition.execute("call-2", { action: "list" }, undefined, undefined, mockCtx.ctx);
  assert.match(resB.content[0].text, /Branch B task/);
  assert.doesNotMatch(resB.content[0].text, /Branch A task/);
});

test("snapshot recovery rejects nonsequential ids without reviving an older plan", async () => {
  const harness = await createExtensionTestHarness();
  const snapshot = (ids) => ({
    type: "custom", customType: "pi-todo-state",
    data: { version: 1, items: ids.map((id) => ({ id, text: `Task ${id}`, status: "pending" })) },
  });
  for (const ids of [[99], [1, 3], [2, 1], [Number.MAX_SAFE_INTEGER + 1]]) {
    const mock = harness.createMockContext({
      sessionManager: { getBranch: () => [snapshot([1]), snapshot(ids)] },
    });
    await harness.ext.handlers.get("session_start")[0]({ type: "session_start", reason: "resume" }, mock.ctx);
    const result = await harness.tool.definition.execute("list", { action: "list" }, undefined, undefined, mock.ctx);
    assert.deepEqual(result.structuredContent.items, [], `invalid ids ${ids} must clear current plan`);
    assert.equal(mock.notifications.length, 1, "corrupt latest snapshot must warn");
    assert.equal(mock.getWidgetContent(), undefined);
    assert.equal(harness.customEntries.length, 0, "recovery must not rewrite session history");
  }
});
