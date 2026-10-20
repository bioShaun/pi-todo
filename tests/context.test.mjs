import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createExtensionTestHarness, getHostRoot } from "./harness.mjs";

const hostRoot = getHostRoot();
const { convertToLlm } = await import(
  path.join(hostRoot, "@earendil-works/pi-coding-agent/dist/core/messages.js")
);
const { convertResponsesMessages } = await import(
  path.join(hostRoot, "@earendil-works/pi-ai/dist/api/openai-responses-shared.js")
);

const dummyModel = { provider: "openai", model: "gpt-4o", input: ["text"] };

function isPrefix(prefixArray, fullArray) {
  if (prefixArray.length > fullArray.length) return false;
  for (let i = 0; i < prefixArray.length; i++) {
    if (JSON.stringify(prefixArray[i]) !== JSON.stringify(fullArray[i])) {
      return false;
    }
  }
  return true;
}

test("streaming sendMessage: A->B->A sequence queues both B and A without projection suppression", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, sentMessages } = harness;
  // A projection that starts with plan A
  const planA = [{ id: 1, text: "Task A", status: "pending" }];
  const contentA = JSON.stringify({ todos: planA });
  const planB = [{ id: 1, text: "Task B", status: "in_progress" }];
  const contentB = JSON.stringify({ todos: planB });

  // Mock ctx where projection holds A already (e.g. from prior turn), and during streaming
  // calls to sendMessage go to queue, NOT into ctx.sessionManager.buildSessionProjection().
  const mock = harness.createMockContext({
    sessionManager: {
      getBranch: () => [
        { type: "custom", customType: "pi-todo-state", data: { version: 1, items: planA } },
      ],
      buildSessionProjection: () => ({
        messages: [
          { role: "custom", customType: "pi-todo-context", content: contentA, display: false },
        ],
      }),
    },
  });

  // Restore state to plan A
  const sessionStartHandlers = harness.ext.handlers.get("session_start") || [];
  await sessionStartHandlers[0]({ type: "session_start" }, mock.ctx);
  sentMessages.length = 0; // Clear any start messages

  // In the same turn / streaming sequence:
  // Step 1: Update to B
  const resB = await tool.definition.execute("call-B", {
    action: "set",
    items: [{ text: "Task B", status: "in_progress" }],
  }, undefined, undefined, mock.ctx);
  assert.equal(resB.isError, undefined);
  assert.equal(sentMessages.length, 1, "update to B must queue message");
  assert.equal(sentMessages[0].message.content, contentB);

  // Step 2: Update back to A
  // Projection still returns contentA! If execute checks projection, it will mistakenly skip A!
  const resA = await tool.definition.execute("call-A", {
    action: "set",
    items: [{ text: "Task A", status: "pending" }],
  }, undefined, undefined, mock.ctx);
  assert.equal(resA.isError, undefined);
  assert.equal(sentMessages.length, 2, "update back to A must queue message B and message A");
  assert.equal(sentMessages[1].message.content, contentA, "final queued message must be A");
});

test("harness: effectiveSessionManager preserves buildSessionProjection when getBranch is overridden", async () => {
  const harness = await createExtensionTestHarness();
  const mock = harness.createMockContext({
    sessionManager: {
      getBranch: () => [
        { type: "custom_message", customType: "pi-todo-context", content: "test-content" },
      ],
    },
  });
  assert.equal(typeof mock.ctx.sessionManager.buildSessionProjection, "function");
  const proj = mock.ctx.sessionManager.buildSessionProjection();
  assert.ok(proj && Array.isArray(proj.messages));
  assert.equal(proj.messages.length, 1);
  assert.equal(proj.messages[0].customType, "pi-todo-context");
});

test("context: set, update, clear trigger sendMessage; list, errors, and no-ops do not", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, sentMessages, createMockContext } = harness;
  const mock = createMockContext();

  // 1. Valid set -> 1 message
  const resSet = await tool.definition.execute("call-1", {
    action: "set",
    items: [
      { text: "Task 1", status: "pending" },
      { text: "Task 2", status: "in_progress" },
    ],
  }, undefined, undefined, mock.ctx);
  assert.equal(resSet.isError, undefined);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].message.customType, "pi-todo-context");
  assert.equal(sentMessages[0].message.display, false);
  assert.equal(sentMessages[0].options?.triggerTurn, false);
  const content1 = JSON.parse(sentMessages[0].message.content);
  assert.equal(content1.todos.length, 2);

  // 2. List -> no message
  const resList = await tool.definition.execute("call-2", {
    action: "list",
  }, undefined, undefined, mock.ctx);
  assert.equal(resList.isError, undefined);
  assert.equal(sentMessages.length, 1, "list must not send context message");

  // 3. Error (invalid update) -> no message
  const resErr = await tool.definition.execute("call-3", {
    action: "update",
    updates: [{ id: 999, status: "completed" }],
  }, undefined, undefined, mock.ctx);
  assert.equal(resErr.isError, true);
  assert.equal(sentMessages.length, 1, "error must not send context message");

  // 4. No-op update (same status/text) -> no message
  const resNoop = await tool.definition.execute("call-4", {
    action: "update",
    updates: [{ id: 1, status: "pending" }],
  }, undefined, undefined, mock.ctx);
  assert.equal(resNoop.isError, undefined);
  assert.equal(sentMessages.length, 1, "no-op update must not send context message");

  // 5. Valid update -> 2nd message
  const resUpdate = await tool.definition.execute("call-5", {
    action: "update",
    updates: [{ id: 1, status: "completed" }],
  }, undefined, undefined, mock.ctx);
  assert.equal(resUpdate.isError, undefined);
  assert.equal(sentMessages.length, 2, "state-changing update must send context message");

  // 6. Complete remaining -> 3rd message with empty todos
  const resComplete = await tool.definition.execute("call-6", {
    action: "update",
    updates: [{ id: 2, status: "completed" }],
  }, undefined, undefined, mock.ctx);
  assert.equal(resComplete.isError, undefined);
  assert.equal(sentMessages.length, 3);
  const content3 = JSON.parse(sentMessages[2].message.content);
  assert.deepEqual(content3.todos, [], "all completed sends todos: [] snapshot");

  // 7. Clear -> clears completed items
  const resClear = await tool.definition.execute("call-7", {
    action: "clear",
  }, undefined, undefined, mock.ctx);
  assert.equal(resClear.isError, undefined);
  // Clear from empty or already all-completed: if content is already {"todos":[]}, no duplicate message sent
  // But if clear from active tasks:
  await tool.definition.execute("call-8", {
    action: "set",
    items: [{ text: "Active task", status: "pending" }],
  }, undefined, undefined, mock.ctx);
  const countBeforeClear = sentMessages.length;
  await tool.definition.execute("call-9", {
    action: "clear",
  }, undefined, undefined, mock.ctx);
  assert.equal(sentMessages.length, countBeforeClear + 1);
  const contentClear = JSON.parse(sentMessages.at(-1).message.content);
  assert.deepEqual(contentClear.todos, [], "clear sends todos: [] snapshot");

  // 8. Clear on empty list -> no-op, no message
  const countEmptyClear = sentMessages.length;
  await tool.definition.execute("call-10", {
    action: "clear",
  }, undefined, undefined, mock.ctx);
  assert.equal(sentMessages.length, countEmptyClear, "clear on already empty list must not send message");
});

test("prefix caching: two consecutive model requests with real convertToLlm + convertResponsesMessages are append-only prefix", async () => {
  const harness = await createExtensionTestHarness();
  const { tool, createMockContext } = harness;
  const mock = createMockContext();

  // Simulate Turn 1:
  // User says hello, Assistant calls set todo, toolResult is returned,
  // custom message is appended at turn_end.
  const turn1RawMessages = [
    { role: "user", content: "Plan our work", timestamp: 1000 },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-set",
          name: "todo",
          arguments: {
            action: "set",
            items: [
              { text: "Phase 1: Implementation", status: "in_progress" },
              { text: "Phase 2: Validation", status: "pending" },
            ],
          },
        },
      ],
      timestamp: 1001,
    },
  ];

  // Execute the tool call
  const setRes = await tool.definition.execute("call-set", {
    action: "set",
    items: [
      { text: "Phase 1: Implementation", status: "in_progress" },
      { text: "Phase 2: Validation", status: "pending" },
    ],
  }, undefined, undefined, mock.ctx);
  assert.equal(setRes.isError, undefined);

  turn1RawMessages.push({
    role: "toolResult",
    toolCallId: "call-set",
    toolName: "todo",
    content: setRes.content,
    timestamp: 1002,
  });

  // End of turn 1: custom message queued by sendMessage is flushed
  assert.ok(harness.sentMessages.length > 0);
  const snapshot1 = harness.sentMessages[0];
  turn1RawMessages.push({
    role: "custom",
    customType: snapshot1.message.customType,
    content: snapshot1.message.content,
    display: snapshot1.message.display,
    timestamp: 1003,
  });

  // Convert turn 1 to model inputs
  const llm1 = convertToLlm(turn1RawMessages);
  const resp1 = convertResponsesMessages(dummyModel, { messages: llm1 }, new Set());

  // Turn 2: User says "continue", Assistant calls update (Phase 1 completed, Phase 2 in_progress)
  const turn2RawMessages = [
    ...turn1RawMessages,
    { role: "assistant", content: [{ type: "text", text: "I have created the plan." }], timestamp: 1004 },
    { role: "user", content: "Proceed with Phase 1 completion", timestamp: 1005 },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-upd",
          name: "todo",
          arguments: {
            action: "update",
            updates: [
              { id: 1, status: "completed" },
              { id: 2, status: "in_progress" },
            ],
          },
        },
      ],
      timestamp: 1006,
    },
  ];

  const updRes = await tool.definition.execute("call-upd", {
    action: "update",
    updates: [
      { id: 1, status: "completed" },
      { id: 2, status: "in_progress" },
    ],
  }, undefined, undefined, mock.ctx);
  assert.equal(updRes.isError, undefined);

  turn2RawMessages.push({
    role: "toolResult",
    toolCallId: "call-upd",
    toolName: "todo",
    content: updRes.content,
    timestamp: 1007,
  });

  const snapshot2 = harness.sentMessages[1];
  turn2RawMessages.push({
    role: "custom",
    customType: snapshot2.message.customType,
    content: snapshot2.message.content,
    display: snapshot2.message.display,
    timestamp: 1008,
  });

  const llm2 = convertToLlm(turn2RawMessages);
  const resp2 = convertResponsesMessages(dummyModel, { messages: llm2 }, new Set());

  // Check prefix invariant for update
  assert.ok(
    isPrefix(resp1, resp2),
    "Turn 1 responses items must be a strict prefix of Turn 2"
  );

  // Turn 3: todo unchanged (no-op update)
  const sentCountBefore3 = harness.sentMessages.length;
  const noopRes = await tool.definition.execute("call-noop", {
    action: "update",
    updates: [{ id: 1, status: "completed" }],
  }, undefined, undefined, mock.ctx);
  assert.equal(noopRes.isError, undefined);
  assert.equal(harness.sentMessages.length, sentCountBefore3, "no new message on no-op");

  const turn3RawMessages = [
    ...turn2RawMessages,
    { role: "assistant", content: [{ type: "text", text: "Proceeding" }], timestamp: 1009 },
    { role: "user", content: "Repeat status check", timestamp: 1010 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-noop", name: "todo", arguments: { action: "update", updates: [{ id: 1, status: "completed" }] } }],
      timestamp: 1011,
    },
    { role: "toolResult", toolCallId: "call-noop", toolName: "todo", content: noopRes.content, timestamp: 1012 },
  ];
  const llm3 = convertToLlm(turn3RawMessages);
  const resp3 = convertResponsesMessages(dummyModel, { messages: llm3 }, new Set());
  assert.ok(isPrefix(resp2, resp3), "Turn 2 must be strict prefix of Turn 3 (no-op)");

  // Turn 4: todo completed all
  const compRes = await tool.definition.execute("call-comp", {
    action: "update",
    updates: [{ id: 2, status: "completed" }],
  }, undefined, undefined, mock.ctx);
  assert.equal(compRes.isError, undefined);
  const snapshot4 = harness.sentMessages.at(-1);

  const turn4RawMessages = [
    ...turn3RawMessages,
    { role: "assistant", content: [{ type: "text", text: "All work completed" }], timestamp: 1013 },
    { role: "user", content: "Wrap up", timestamp: 1014 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-comp", name: "todo", arguments: { action: "update", updates: [{ id: 2, status: "completed" }] } }],
      timestamp: 1015,
    },
    { role: "toolResult", toolCallId: "call-comp", toolName: "todo", content: compRes.content, timestamp: 1016 },
    {
      role: "custom",
      customType: snapshot4.message.customType,
      content: snapshot4.message.content,
      display: snapshot4.message.display,
      timestamp: 1017,
    },
  ];
  const llm4 = convertToLlm(turn4RawMessages);
  const resp4 = convertResponsesMessages(dummyModel, { messages: llm4 }, new Set());
  assert.ok(isPrefix(resp3, resp4), "Turn 3 must be strict prefix of Turn 4 (completed)");

  // Turn 5: todo clear from completed
  // Setting new tasks first so clear actually changes state
  await tool.definition.execute("call-preclear-set", {
    action: "set",
    items: [{ text: "Temporary item", status: "pending" }],
  }, undefined, undefined, mock.ctx);

  const clearRes = await tool.definition.execute("call-clear", {
    action: "clear",
  }, undefined, undefined, mock.ctx);
  assert.equal(clearRes.isError, undefined);
  const snapshot5 = harness.sentMessages.at(-1);

  const turn5RawMessages = [
    ...turn4RawMessages,
    { role: "assistant", content: [{ type: "text", text: "Clearing plan" }], timestamp: 1018 },
    { role: "user", content: "Clear all", timestamp: 1019 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-clear", name: "todo", arguments: { action: "clear" } }],
      timestamp: 1020,
    },
    { role: "toolResult", toolCallId: "call-clear", toolName: "todo", content: clearRes.content, timestamp: 1021 },
    {
      role: "custom",
      customType: snapshot5.message.customType,
      content: snapshot5.message.content,
      display: snapshot5.message.display,
      timestamp: 1022,
    },
  ];
  const llm5 = convertToLlm(turn5RawMessages);
  const resp5 = convertResponsesMessages(dummyModel, { messages: llm5 }, new Set());
  assert.ok(isPrefix(resp4, resp5), "Turn 4 must be strict prefix of Turn 5 (clear)");

  // Turn 6: streaming / codemode A->B->A sequence simulation
  // During an active turn, projection contains A.
  // 1) Model updates to B -> queued custom message for B.
  // 2) Model updates back to A in the same turn -> queued custom message for A.
  // Both B and A must be queued, and final state must be A.
  const initialSentCount = harness.sentMessages.length;
  // Step 1: Update to B
  const resB = await tool.definition.execute("stream-call-B", {
    action: "set",
    items: [{ text: "Plan B", status: "in_progress" }],
  }, undefined, undefined, mock.ctx);
  assert.equal(resB.isError, undefined);
  assert.equal(harness.sentMessages.length, initialSentCount + 1, "update to B must queue message");

  // Step 2: Update back to A (empty plan or Plan A)
  // Note: if execute checked projection (which hasn't flushed yet and still has empty/previous),
  // it might skip queueing A! The fix ensures actual item difference triggers sendMessage.
  const resA = await tool.definition.execute("stream-call-A", {
    action: "clear",
  }, undefined, undefined, mock.ctx);
  assert.equal(resA.isError, undefined);
  assert.equal(harness.sentMessages.length, initialSentCount + 2, "update back to A (clear) must queue message even if projection unchanged");
  const queuedA = JSON.parse(harness.sentMessages.at(-1).message.content);
  assert.deepEqual(queuedA.todos, [], "last queued snapshot is A (empty)");

  // Complete Turn 6 with flush at turn end
  const snapshotB = harness.sentMessages[initialSentCount];
  const snapshotA = harness.sentMessages[initialSentCount + 1];

  const turn6RawMessages = [
    ...turn5RawMessages,
    { role: "user", content: "Run streaming tool calls A->B->A", timestamp: 1023 },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "stream-call-B", name: "todo", arguments: { action: "set", items: [{ text: "Plan B", status: "in_progress" }] } },
      ],
      timestamp: 1024,
    },
    {
      role: "toolResult",
      toolCallId: "stream-call-B",
      toolName: "todo",
      content: resB.content,
      timestamp: 1025,
    },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "stream-call-A", name: "todo", arguments: { action: "clear" } },
      ],
      timestamp: 1026,
    },
    {
      role: "toolResult",
      toolCallId: "stream-call-A",
      toolName: "todo",
      content: resA.content,
      timestamp: 1027,
    },
    // Both flushed in order after turn
    {
      role: "custom",
      customType: snapshotB.message.customType,
      content: snapshotB.message.content,
      display: snapshotB.message.display,
      timestamp: 1028,
    },
    {
      role: "custom",
      customType: snapshotA.message.customType,
      content: snapshotA.message.content,
      display: snapshotA.message.display,
      timestamp: 1029,
    },
  ];
  const llm6 = convertToLlm(turn6RawMessages);
  const resp6 = convertResponsesMessages(dummyModel, { messages: llm6 }, new Set());
  assert.ok(isPrefix(resp5, resp6), "Turn 5 must be strict prefix of Turn 6 (streaming A->B->A)");
});

test("branch restoration and compaction: no duplicate when content unchanged, recovers once when missing or compacted", async () => {
  const harness = await createExtensionTestHarness();
  const { ext, sentMessages } = harness;

  const sessionStartHandlers = ext.handlers.get("session_start") || [];
  const sessionTreeHandlers = ext.handlers.get("session_tree") || [];
  const sessionCompactHandlers = ext.handlers.get("session_compact") || [];

  assert.ok(sessionStartHandlers.length > 0, "session_start handler registered");
  assert.ok(sessionTreeHandlers.length > 0, "session_tree handler registered");
  assert.ok(sessionCompactHandlers.length > 0, "session_compact handler registered");

  // Case 1: Session start with empty branch and no old snapshot -> no message sent
  const emptyCtx = harness.createMockContext({
    sessionManager: {
      getBranch: () => [],
      buildSessionProjection: () => ({ messages: [] }),
    },
  }).ctx;

  sentMessages.length = 0;
  await sessionStartHandlers[0]({ type: "session_start" }, emptyCtx);
  assert.equal(sentMessages.length, 0, "empty start with no old snapshot sends no message");

  // Case 2: Session start with tasks, but projection already contains the identical snapshot -> no duplicate
  const validItems = [{ id: 1, text: "Existing task", status: "pending" }];
  const validSnapshotContent = JSON.stringify({ todos: validItems });
  const branchWithState = [
    { type: "custom", customType: "pi-todo-state", data: { version: 1, items: validItems } },
  ];
  const projectionWithSnapshot = [
    { role: "custom", customType: "pi-todo-context", content: validSnapshotContent, display: false },
  ];

  const matchedCtx = harness.createMockContext({
    sessionManager: {
      getBranch: () => branchWithState,
      buildSessionProjection: () => ({ messages: projectionWithSnapshot }),
    },
  }).ctx;

  sentMessages.length = 0;
  await sessionStartHandlers[0]({ type: "session_start" }, matchedCtx);
  assert.equal(sentMessages.length, 0, "identical snapshot in projection must not trigger duplicate sendMessage");

  // Case 3: Session start with tasks, but snapshot missing in projection -> appends recovery snapshot
  const missingCtx = harness.createMockContext({
    sessionManager: {
      getBranch: () => branchWithState,
      buildSessionProjection: () => ({ messages: [] }), // missing!
    },
  }).ctx;

  sentMessages.length = 0;
  await sessionStartHandlers[0]({ type: "session_start" }, missingCtx);
  assert.equal(sentMessages.length, 1, "missing snapshot in projection must trigger recovery snapshot");
  assert.equal(sentMessages[0].message.content, validSnapshotContent);
  assert.equal(sentMessages[0].options?.triggerTurn, false);

  // Case 4: session_tree switch where branch state changed
  sentMessages.length = 0;
  await sessionTreeHandlers[0]({ type: "session_tree" }, matchedCtx);
  assert.equal(sentMessages.length, 0, "tree navigation to matching snapshot produces no message");

  // Case 5: session_compact where snapshot was compacted away
  // 5a: willRetry = false -> triggerTurn: false
  sentMessages.length = 0;
  await sessionCompactHandlers[0]({
    type: "session_compact",
    reason: "threshold",
    willRetry: false,
    compactionEntry: { id: "c1" },
    fromExtension: false,
  }, missingCtx);
  assert.equal(sentMessages.length, 1, "compacted away snapshot is restored once");
  assert.equal(sentMessages[0].options?.triggerTurn, false);

  // 5b: willRetry = true -> triggerTurn: true, deliverAs: "steer"
  sentMessages.length = 0;
  await sessionCompactHandlers[0]({
    type: "session_compact",
    reason: "overflow",
    willRetry: true,
    compactionEntry: { id: "c2" },
    fromExtension: false,
  }, missingCtx);
  assert.equal(sentMessages.length, 1, "overflow retry compaction uses steer queue");
  assert.equal(sentMessages[0].options?.triggerTurn, true);
  assert.equal(sentMessages[0].options?.deliverAs, "steer");

  // 5c: compact retained the snapshot -> no duplicate
  sentMessages.length = 0;
  await sessionCompactHandlers[0]({
    type: "session_compact",
    reason: "threshold",
    willRetry: false,
    compactionEntry: { id: "c3" },
    fromExtension: false,
  }, matchedCtx);
  assert.equal(sentMessages.length, 0, "compact that retains snapshot produces no duplicate");
});
