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

    const mockCtx = {
      mode: "tui",
      hasUI: true,
      cwd: process.cwd(),
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
      },
      sessionManager: {
        getBranch: () => customEntries,
      },
      ...overrides,
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
    };
  }

  return {
    ext,
    tool,
    todosCmd,
    runtime,
    customEntries,
    createMockContext,
  };
}
