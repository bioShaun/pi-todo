import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getHostRoot } from "../tests/harness.mjs";

const hostRoot = getHostRoot();
const host = path.join(hostRoot, "@earendil-works/pi-coding-agent");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import(path.join(host, "dist/index.js"));
const { KeybindingsManager } = await import(path.join(host, "dist/core/keybindings.js"));
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
  return tool.execute("host-smoke", params, undefined, undefined);
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
  assert.ok(fs.readFileSync(file, "utf8").includes("pi-todo-state"));
  session.dispose();

  session = await openSession(SessionManager.open(file));
  const restored = await call(session, { action: "list" });
  assert.deepEqual(restored.structuredContent.items, set.structuredContent.items);
  const update = await call(session, {
    action: "update", updates: [{ id: 1, status: "completed" }, { id: 2, status: "in_progress" }],
  });
  assert.ok(!update.isError);
  const messages = await session.extensionRunner.emitContext([]);
  assert.equal(messages.filter((message) => message.customType === "pi-todo-context").length, 1);
  const latest = JSON.parse(messages.at(-1).content);
  assert.equal(latest.todos[0].status, "completed");
  assert.equal(latest.todos[1].status, "in_progress");
  assert.deepEqual(session.getActiveToolNames(), baseline);

  await session.navigateTree(anchor, { summarize: false });
  const branched = await call(session, { action: "list" });
  assert.equal(branched.structuredContent.items[0].status, "in_progress");
  assert.equal(branched.structuredContent.items[1].status, "pending");
  await call(session, { action: "clear" });
  assert.deepEqual((await call(session, { action: "list" })).structuredContent.items, []);
  assert.equal((await session.extensionRunner.emitContext([])).length, 0);
  assert.deepEqual(errors, []);
  process.stdout.write("PASS: real Pi SDK loading, wrapped tool execution, JSONL persistence, fresh-session restore, tree navigation, ephemeral context, clear, unchanged active tools. No model requests.\n");
  process.stdout.write(`Evidence session: ${file}\n`);
} finally {
  session?.dispose();
}
