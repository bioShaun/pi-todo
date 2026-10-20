import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getHostRoot } from "../tests/harness.mjs";

const hostRoot = getHostRoot();
const host = path.join(hostRoot, "@earendil-works/pi-coding-agent");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import(path.join(host, "dist/index.js"));
const { KeybindingsManager } = await import(path.join(host, "dist/core/keybindings.js"));
const { convertToLlm } = await import(path.join(host, "dist/core/messages.js"));
const { AssistantMessageEventStream } = await import(
  path.join(hostRoot, "@earendil-works/pi-ai/dist/utils/event-stream.js")
);
const { convertResponsesMessages } = await import(
  path.join(hostRoot, "@earendil-works/pi-ai/dist/api/openai-responses-shared.js")
);

const cwd = process.cwd();
const work = fs.mkdtempSync(path.join(cwd, ".work/host-smoke-"));
const agentDir = path.join(work, "agent");
fs.mkdirSync(agentDir);
const errors = [];
const modelRuntime = await ModelRuntime.create({
  authPath: path.join(agentDir, "auth.json"),
  modelsPath: null,
  modelsStorePath: path.join(agentDir, "models-store.json"),
  allowModelNetwork: false,
  refreshOnCreate: false,
});

async function openSession(manager) {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, packages: [] });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    additionalExtensionPaths: [path.join(cwd, "index.ts")],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader, modelRuntime,
    sessionManager: manager, thinkingLevel: "off",
  });
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  return session;
}

async function call(session, params) {
  const tool = session.agent.state.tools.find((candidate) => candidate.name === "todo");
  assert.ok(tool, "todo is active in the actual host tool registry");
  return tool.execute("host-smoke", params, undefined, undefined, session.extensionRunner.createContext());
}

function isPrefix(prefixArray, fullArray) {
  if (prefixArray.length > fullArray.length) return false;
  for (let i = 0; i < prefixArray.length; i++) {
    if (JSON.stringify(prefixArray[i]) !== JSON.stringify(fullArray[i])) {
      return false;
    }
  }
  return true;
}

let session;
try {
  const manager = SessionManager.create(cwd, path.join(work, "sessions"));
  manager.appendMessage({ role: "user", content: "Offline todo host smoke test", timestamp: Date.now() });
  session = await openSession(manager);
  const shortcuts = session.extensionRunner.getShortcuts(KeybindingsManager.create(agentDir).getResolvedBindings());
  assert.ok(shortcuts.has("alt+t"), "Alt+T survives host shortcut conflict resolution");
  assert.deepEqual(session.extensionRunner.getShortcutDiagnostics(), []);
  assert.ok(session.getActiveToolNames().includes("todo"));
  const baseline = session.getActiveToolNames();

  // 1. Initial set: creates state entry and persistent custom message entry
  const set = await call(session, {
    action: "set", items: [
      { text: "宿主加载与写入", status: "in_progress" },
      { text: "恢复与分支验收", status: "pending" },
      { text: "独立审查", status: "blocked", reason: "等待证据" },
    ],
  });
  assert.ok(!set.isError, JSON.stringify(set));
  const anchor = manager.getLeafId();
  const file = manager.getSessionFile();
  const rawJsonl = fs.readFileSync(file, "utf8");
  assert.ok(rawJsonl.includes("pi-todo-state"), "JSONL contains pi-todo-state");
  assert.ok(rawJsonl.includes("pi-todo-context"), "JSONL contains persistent pi-todo-context custom message");
  session.dispose();

  // 2. Fresh session reload from JSONL
  const snapshotsBeforeReload = manager.buildSessionProjection().messages.filter((message) => message.customType === "pi-todo-context").length;
  session = await openSession(SessionManager.open(file));
  assert.equal(session.sessionManager.buildSessionProjection().messages.filter((message) => message.customType === "pi-todo-context").length, snapshotsBeforeReload, "reload must not duplicate a matching snapshot");
  const restored = await call(session, { action: "list" });
  assert.deepEqual(restored.structuredContent.items, set.structuredContent.items);

  // 3. Update tasks: updates state and appends new snapshot
  const update = await call(session, {
    action: "update", updates: [{ id: 1, status: "completed" }, { id: 2, status: "in_progress" }],
  });
  assert.ok(!update.isError);

  const projMessages = session.sessionManager.buildSessionProjection().messages;
  const todoContextMsgs = projMessages.filter((m) => m.customType === "pi-todo-context");
  assert.ok(todoContextMsgs.length >= 2, "session contains persistent snapshots");
  const latest = JSON.parse(todoContextMsgs.at(-1).content);
  assert.equal(latest.todos[0].status, "completed");
  assert.equal(latest.todos[1].status, "in_progress");
  assert.deepEqual(session.getActiveToolNames(), baseline);

  // 4. Tree navigation
  await session.navigateTree(anchor, { summarize: false });
  const branched = await call(session, { action: "list" });
  assert.equal(branched.structuredContent.items[0].status, "in_progress");
  assert.equal(branched.structuredContent.items[1].status, "pending");

  // 5. Clear: resets state and appends empty snapshot { todos: [] }
  await call(session, { action: "clear" });
  assert.deepEqual((await call(session, { action: "list" })).structuredContent.items, []);
  const afterClearMsgs = session.sessionManager.buildSessionProjection().messages;
  const clearSnapshot = afterClearMsgs.filter((m) => m.customType === "pi-todo-context").at(-1);
  assert.deepEqual(JSON.parse(clearSnapshot.content), { todos: [] }, "cleared plan snapshot has todos: []");

  // 6. Offline turn_end flush and prefix cache invariant verification (no model network requests)
  const dummyModel = { provider: "openai", model: "gpt-4o", input: ["text"] };
  const mockTool = session.agent.state.tools.find((candidate) => candidate.name === "todo");

  // Turn 1: simulate running turn with tool execution via _handleAgentEvent turn_end
  session._isAgentRunActive = true;
  await mockTool.execute("smoke-call-1", {
    action: "set",
    items: [
      { text: "Turn 1 task A", status: "in_progress" },
      { text: "Turn 1 task B", status: "pending" },
    ],
  }, undefined, undefined, session.extensionRunner.createContext());

  assert.equal(session._pendingCustomMessages.length, 1, "custom message is queued while running");
  // Tool result appended by agent runner at turn end
  session.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "smoke-call-1", name: "todo", arguments: {} }],
    timestamp: Date.now(),
  });
  const tr1 = {
    role: "toolResult",
    toolCallId: "smoke-call-1",
    toolName: "todo",
    content: [{ type: "text", text: "done" }],
    timestamp: Date.now(),
  };
  session.sessionManager.appendMessage(tr1);
  session._isAgentRunActive = false;
  // Trigger flush via real session._handleAgentEvent turn_end
  await session._handleAgentEvent({
    type: "turn_end",
    message: { role: "assistant", content: [] },
    toolResults: [tr1],
  });
  assert.equal(session._pendingCustomMessages.length, 0, "pending custom messages flushed on turn_end");

  const turn1Llm = convertToLlm(session.sessionManager.buildSessionProjection().messages);
  const turn1Inputs = convertResponsesMessages(dummyModel, { messages: turn1Llm }, new Set());

  // Turn 2: next turn completes task A, starts task B
  session._isAgentRunActive = true;
  session.sessionManager.appendMessage({ role: "user", content: "Continue work", timestamp: Date.now() });
  await mockTool.execute("smoke-call-2", {
    action: "update",
    updates: [
      { id: 1, status: "completed" },
      { id: 2, status: "in_progress" },
    ],
  }, undefined, undefined, session.extensionRunner.createContext());

  session.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "smoke-call-2", name: "todo", arguments: {} }],
    timestamp: Date.now(),
  });
  const tr2 = {
    role: "toolResult",
    toolCallId: "smoke-call-2",
    toolName: "todo",
    content: [{ type: "text", text: "done" }],
    timestamp: Date.now(),
  };
  session.sessionManager.appendMessage(tr2);
  session._isAgentRunActive = false;
  await session._handleAgentEvent({
    type: "turn_end",
    message: { role: "assistant", content: [] },
    toolResults: [tr2],
  });
  assert.equal(session._pendingCustomMessages.length, 0, "pending custom messages flushed on turn_end");

  const turn2Llm = convertToLlm(session.sessionManager.buildSessionProjection().messages);
  const turn2Inputs = convertResponsesMessages(dummyModel, { messages: turn2Llm }, new Set());

  assert.ok(isPrefix(turn1Inputs, turn2Inputs), "Turn 1 model inputs must be a strict prefix of Turn 2 model inputs");

  // 7. Compaction & steering queue verification:
  // Trigger session_compact with willRetry: true while agent is active and projection lacks snapshot.
  session._isAgentRunActive = true;
  // Create a compaction entry that compacts away previous messages (firstKeptEntryId is a new point)
  const compactionEntryId = session.sessionManager.appendCompaction(
    "Compacted prior context",
    null, // null firstKeptEntryId compacts all prior entries
    1000
  );
  const compactionEntry = session.sessionManager.getEntry(compactionEntryId);

  // Emit session_compact with willRetry: true
  await session.extensionRunner.emit({
    type: "session_compact",
    compactionEntry,
    fromExtension: false,
    reason: "overflow",
    willRetry: true,
  });

  // Verify that recovery snapshot enters steering queue, NOT pendingCustomMessages
  const queuedSteering = session.agent.peekQueuedMessages();
  assert.ok(queuedSteering.length > 0, "steering queue has recovery message");
  assert.equal(queuedSteering[0].role, "custom");
  assert.equal(queuedSteering[0].customType, "pi-todo-context");
  assert.equal(session._pendingCustomMessages.length, 0, "pendingCustomMessages must be empty during willRetry compaction");

  // Consume the actual steering queue through the local agent loop. Only the
  // provider response is replaced; projection, queue delivery and events are real.
  const expectedSnapshot = queuedSteering.at(-1).content;
  const offlineModel = {
    id: "offline-cache-test", name: "Offline cache test", provider: "offline",
    api: "openai-responses", baseUrl: "http://localhost.invalid",
    reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  session.agent.state.model = offlineModel;
  let localRequests = 0;
  session.agent.streamFunction = (_model, context) => {
    localRequests++;
    assert.ok(context.messages.some((message) => message.role === "user" && message.content?.some?.((part) => part.text === expectedSnapshot)), "retry request must contain the restored snapshot");
    const message = {
      role: "assistant", provider: "offline", model: offlineModel.id,
      api: offlineModel.api, content: [{ type: "text", text: "Offline retry complete" }],
      stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  };
  await session.agent.continue();
  session._isAgentRunActive = false;
  assert.equal(localRequests, 1, "recovery must use one planned retry without an extra model turn");
  assert.equal(session.agent.peekQueuedMessages().length, 0);
  const recoveredMessages = session.sessionManager.buildSessionProjection().messages;
  assert.equal(recoveredMessages.filter((message) => message.customType === "pi-todo-context").length, 1);
  const leafBeforeRetained = session.sessionManager.getLeafId();
  await session.extensionRunner.emit({ type: "session_compact", compactionEntry,
    fromExtension: false, reason: "threshold", willRetry: false });
  assert.equal(session.sessionManager.getLeafId(), leafBeforeRetained, "retained snapshot must not be duplicated");

  // Manual compaction restores a removed snapshot immediately without starting a run.
  const manualId = session.sessionManager.appendCompaction("Second offline summary", null, 1000);
  assert.equal(session.sessionManager.buildSessionProjection().messages.filter((message) => message.customType === "pi-todo-context").length, 0);
  await session.extensionRunner.emit({ type: "session_compact",
    compactionEntry: session.sessionManager.getEntry(manualId), fromExtension: false,
    reason: "manual", willRetry: false });
  assert.equal(session.sessionManager.buildSessionProjection().messages.filter((message) => message.customType === "pi-todo-context").length, 1);
  assert.equal(localRequests, 1, "manual recovery must not trigger a model request");

  assert.deepEqual(errors, []);
  process.stdout.write("PASS: real Pi SDK loading, wrapped tool execution, JSONL persistence, fresh-session restore, tree navigation, persistent custom_message context, prefix projection, one local retry consuming steering recovery, manual compaction recovery, clear, unchanged active tools. No remote model requests.\n");
  process.stdout.write(`Evidence session: ${file}\n`);
} finally {
  session?.dispose();
}
