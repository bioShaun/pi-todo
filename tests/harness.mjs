import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function getHostRoot() {
  if (process.env.PI_TEST_HOST_ROOT) {
    return process.env.PI_TEST_HOST_ROOT;
  }
  const currentVersionFile = path.join(os.homedir(), ".pi/agent/install/current-version");
  if (fs.existsSync(currentVersionFile)) {
    const version = fs.readFileSync(currentVersionFile, "utf-8").trim();
    const candidate = path.join(os.homedir(), ".pi/agent/install/releases", version, "node_modules");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Cannot find PI host root");
}

/**
 * Minimal stand-in for the host Theme: emits SGR sequences and records the
 * tokens requested, so tests can assert both styling and layout.
 */
export function createThemeStub() {
  const tokens = [];
  const codes = { accent: 36, success: 32, warning: 33, muted: 90, dim: 2 };
  return {
    tokens,
    fg(token, text) {
      tokens.push(token);
      return `\x1b[${codes[token] ?? 39}m${text}\x1b[39m`;
    },
    bold(text) {
      return `\x1b[1m${text}\x1b[22m`;
    },
  };
}

export async function createExtensionTestHarness(options = {}) {
  const hostRoot = getHostRoot();
  const loaderPath = path.join(
    hostRoot,
    "@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"
  );
  const { loadExtensions, createExtensionRuntime } = await import(loaderPath);

  const runtime = createExtensionRuntime();
  const customEntries = [];
  const sentMessages = [];

  runtime.appendEntry = (customType, data) => {
    if (options.appendEntryError) {
      throw new Error(options.appendEntryError);
    }
    customEntries.push({
      type: "custom",
      customType,
      data: JSON.parse(JSON.stringify(data)),
    });
  };

  runtime.sendMessage = (message, sendOptions) => {
    if (options.sendMessageError) {
      throw new Error(options.sendMessageError);
    }
    sentMessages.push({
      message: JSON.parse(JSON.stringify(message)),
      options: sendOptions ? JSON.parse(JSON.stringify(sendOptions)) : undefined,
    });
  };

  const extensionPath = path.resolve(process.cwd(), "index.ts");
  const result = await loadExtensions([extensionPath], process.cwd(), undefined, runtime);
  if (result.errors && result.errors.length > 0) {
    throw new Error("Failed to load extension: " + JSON.stringify(result.errors));
  }

  const ext = result.extensions[0];
  const tool = ext.tools.get("todo");
  const todosCmd = ext.commands.get("todos");

  function createMockContext(overrides = {}) {
    const notifications = [];
    let widgetContent = null;
    let widgetOptions = null;
    let selectedTitle = null;
    let selectedOptions = null;
    let detailComponent;
    let detailClosed = false;
    const terminal = { rows: 20 };

    function buildDefaultProjection(sourceEntries = customEntries) {
      const messages = [];
      for (const entry of sourceEntries) {
        if (entry.type === "custom_message") {
          messages.push({
            role: "custom",
            customType: entry.customType,
            content: entry.content ?? [],
            display: entry.display,
            details: entry.details,
            timestamp: entry.timestamp || 1000,
          });
        } else if (entry.type === "message") {
          messages.push(entry.message);
        }
      }
      for (const s of sentMessages) {
        messages.push({
          role: "custom",
          customType: s.message.customType,
          content: s.message.content ?? [],
          display: s.message.display,
          details: s.message.details,
          timestamp: 2000,
        });
      }
      return { messages };
    }

    const defaultSessionManager = {
      getBranch: () => customEntries,
      buildSessionProjection: () => buildDefaultProjection(customEntries),
    };

    const effectiveSessionManager = overrides.sessionManager
      ? {
          buildSessionProjection: () => {
            const branch = overrides.sessionManager.getBranch?.() || [];
            return buildDefaultProjection(branch);
          },
          ...overrides.sessionManager,
        }
      : defaultSessionManager;

    const mockCtx = {
      mode: "tui",
      hasUI: true,
      cwd: process.cwd(),
      ...overrides,
      ui: {
        notify: (msg, type) => {
          notifications.push({ msg, type });
        },
        setWidget: (key, content, opts) => {
          widgetContent = content;
          widgetOptions = opts;
        },
        select: async (title, optsList) => {
          selectedTitle = title;
          selectedOptions = optsList;
          return undefined; // simulate Esc
        },
        custom: async (factory) => {
          detailComponent = factory({ terminal, requestRender() {} }, createThemeStub(), {}, () => { detailClosed = true; });
        },
        ...overrides.ui,
      },
      sessionManager: effectiveSessionManager,
    };

    return {
      ctx: mockCtx,
      notifications,
      getWidgetContent: (width = 80, theme = undefined) => {
        if (!widgetContent) return undefined;
        if (typeof widgetContent === "function") {
          const comp = widgetContent(undefined, theme);
          if (comp && typeof comp.render === "function") {
            const lines = comp.render(width);
            return lines && lines.length > 0 ? lines : undefined;
          }
        }
        return widgetContent;
      },
      getWidgetRaw: () => widgetContent,
      getWidgetComponent: (theme = undefined) => {
        if (typeof widgetContent === "function") {
          return widgetContent(undefined, theme);
        }
        return null;
      },
      getWidgetOptions: () => widgetOptions,
      getSelectState: () => ({ selectedTitle, selectedOptions }),
      getDetails: () => ({ component: detailComponent, closed: detailClosed, terminal }),
    };
  }

  return {
    ext,
    tool,
    todosCmd,
    runtime,
    customEntries,
    sentMessages,
    createMockContext,
  };
}
