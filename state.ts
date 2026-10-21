export const MAX_ITEMS = 20;
export const MAX_TEXT = 160;
export const MAX_REASON = 240;

export type TodoStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface TodoItem {
  id: number;
  text: string;
  status: TodoStatus;
  reason?: string;
}

export interface TodoStateSnapshot {
  version: 1;
  items: TodoItem[];
}

export interface TodoSetItemInput {
  text: string;
  status?: TodoStatus;
  reason?: string;
}

export interface TodoUpdateItemInput {
  id: number;
  status?: TodoStatus;
  text?: string;
  reason?: string;
}

export interface TodoMutationResult {
  success: boolean;
  error?: string;
}

function clone<T>(val: T): T {
  return JSON.parse(JSON.stringify(val));
}

export function isValidStatus(status: unknown): status is TodoStatus {
  return (
    status === "pending" ||
    status === "in_progress" ||
    status === "completed" ||
    status === "blocked"
  );
}

export function validateItemText(text: unknown): { valid: boolean; text?: string; error?: string } {
  if (typeof text !== "string") {
    return { valid: false, error: "Task text must be a string" };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "Task text cannot be blank" };
  }
  if (trimmed.length > MAX_TEXT) {
    return { valid: false, error: `Task text cannot exceed ${MAX_TEXT} characters` };
  }
  return { valid: true, text: trimmed };
}

export function validateReason(reason: unknown): { valid: boolean; reason?: string; error?: string } {
  if (typeof reason !== "string") {
    return { valid: false, error: "Blocked reason must be a string" };
  }
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "Blocked reason cannot be blank" };
  }
  if (trimmed.length > MAX_REASON) {
    return { valid: false, error: `Blocked reason cannot exceed ${MAX_REASON} characters` };
  }
  return { valid: true, reason: trimmed };
}

function normalizeReason(status: TodoStatus, reason: unknown): { valid: boolean; reason?: string; error?: string } {
  if (status === "blocked") return validateReason(reason);
  if (typeof reason === "string" && reason.trim() === "") return { valid: true };
  const result = validateReason(reason);
  return result.valid ? { valid: true } : result;
}

export function validateSnapshotItems(items: unknown): { valid: boolean; items?: TodoItem[]; error?: string } {
  if (!Array.isArray(items)) {
    return { valid: false, error: "Items must be an array" };
  }
  if (items.length > MAX_ITEMS) {
    return { valid: false, error: `Todo list cannot exceed ${MAX_ITEMS} items` };
  }

  const result: TodoItem[] = [];
  const seenIds = new Set<number>();
  let inProgressCount = 0;

  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    if (!raw || typeof raw !== "object") {
      return { valid: false, error: `Item at index ${i} is malformed` };
    }

    const id = (raw as Record<string, unknown>).id;
    if (typeof id !== "number" || !Number.isInteger(id) || id !== i + 1) {
      return { valid: false, error: `Item at index ${i} must have sequential id ${i + 1}` };
    }
    if (seenIds.has(id)) {
      return { valid: false, error: `Duplicate item id ${id}` };
    }
    seenIds.add(id);

    const textRes = validateItemText((raw as Record<string, unknown>).text);
    if (!textRes.valid || !textRes.text) {
      return { valid: false, error: textRes.error || `Item ${id} text is invalid` };
    }

    const status = (raw as Record<string, unknown>).status;
    if (!isValidStatus(status)) {
      return { valid: false, error: `Item ${id} has invalid status '${String(status)}'` };
    }

    let reason: string | undefined;
    const rawReason = (raw as Record<string, unknown>).reason;
    if (status === "blocked") {
      const reasonRes = normalizeReason(status, rawReason);
      if (!reasonRes.valid || !reasonRes.reason) {
        const detail = rawReason === undefined
          ? "missing non-blank reason"
          : `has invalid reason: ${reasonRes.error ?? "unknown error"}`;
        return { valid: false, error: `Item ${id} is blocked but ${detail}` };
      }
      reason = reasonRes.reason;
    } else if (rawReason !== undefined) {
      const reasonRes = normalizeReason(status, rawReason);
      if (!reasonRes.valid) {
        return { valid: false, error: `Item ${id} has invalid reason: ${reasonRes.error}` };
      }
    }

    if (status === "in_progress") {
      inProgressCount++;
    }

    result.push({
      id,
      text: textRes.text,
      status,
      ...(reason ? { reason } : {}),
    });
  }

  if (inProgressCount > 1) {
    return { valid: false, error: "At most one task can be in_progress at a time" };
  }

  return { valid: true, items: result };
}

export class TodoStateManager {
  private items: TodoItem[] = [];
  private readonly appendEntryFn?: (type: string, data: TodoStateSnapshot) => void;

  constructor(appendEntryFn?: (type: string, data: TodoStateSnapshot) => void) {
    this.appendEntryFn = appendEntryFn;
  }

  public getItems(): TodoItem[] {
    return clone(this.items);
  }

  private commitState(candidate: TodoItem[]): TodoMutationResult {
    const snapshot: TodoStateSnapshot = {
      version: 1,
      items: clone(candidate),
    };

    if (this.appendEntryFn) {
      try {
        this.appendEntryFn("pi-todo-state", snapshot);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Persistence error: ${message}` };
      }
    }

    this.items = candidate;
    return { success: true };
  }

  public set(rawItems: TodoSetItemInput[]): TodoMutationResult {
    if (!Array.isArray(rawItems)) {
      return { success: false, error: "Items must be an array" };
    }
    if (rawItems.length > MAX_ITEMS) {
      return { success: false, error: `Cannot set more than ${MAX_ITEMS} items` };
    }

    if (rawItems.length === 0) {
      return this.clear();
    }

    const candidate: TodoItem[] = [];
    let inProgressCount = 0;

    for (let i = 0; i < rawItems.length; i++) {
      const raw = rawItems[i];
      if (!raw || typeof raw !== "object") {
        return { success: false, error: `Item at index ${i} is malformed` };
      }

      const textRes = validateItemText(raw.text);
      if (!textRes.valid || !textRes.text) {
        return { success: false, error: textRes.error };
      }

      const status = raw.status === undefined ? "pending" : raw.status;
      if (!isValidStatus(status)) {
        return { success: false, error: `Invalid status '${String(status)}'` };
      }

      let reason: string | undefined;
      if (raw.reason !== undefined) {
        const reasonRes = normalizeReason(status, raw.reason);
        if (!reasonRes.valid) {
          return { success: false, error: reasonRes.error || "Invalid reason" };
        }
        reason = reasonRes.reason;
      } else if (status === "blocked") {
        return { success: false, error: "Blocked status requires a reason" };
      }

      if (status === "in_progress") {
        inProgressCount++;
      }

      candidate.push({
        id: i + 1,
        text: textRes.text,
        status,
        ...(reason ? { reason } : {}),
      });
    }

    if (inProgressCount > 1) {
      return { success: false, error: "At most one task can be in_progress at a time" };
    }

    return this.commitState(candidate);
  }

  public update(updates: TodoUpdateItemInput[]): TodoMutationResult {
    if (!Array.isArray(updates) || updates.length === 0) {
      return { success: false, error: "Updates array cannot be empty" };
    }

    const seenIds = new Set<number>();
    for (const u of updates) {
      if (!u || typeof u !== "object" || typeof u.id !== "number" || !Number.isInteger(u.id) || u.id <= 0) {
        return { success: false, error: "Each update must include a positive integer id" };
      }
      if (seenIds.has(u.id)) {
        return { success: false, error: `Duplicate update for task id ${u.id}` };
      }
      seenIds.add(u.id);
    }

    const candidate = clone(this.items);

    for (const u of updates) {
      const idx = candidate.findIndex((item) => item.id === u.id);
      if (idx === -1) {
        return { success: false, error: `Unknown task id ${u.id}` };
      }

      const current = candidate[idx];
      let newText = current.text;
      if (u.text !== undefined) {
        const textRes = validateItemText(u.text);
        if (!textRes.valid || !textRes.text) {
          return { success: false, error: textRes.error };
        }
        newText = textRes.text;
      }

      const newStatus = u.status !== undefined ? u.status : current.status;
      if (!isValidStatus(newStatus)) {
        return { success: false, error: `Invalid status '${String(newStatus)}'` };
      }

      let newReason: string | undefined;
      if (u.reason !== undefined) {
        const reasonRes = normalizeReason(newStatus, u.reason);
        if (!reasonRes.valid) {
          return { success: false, error: reasonRes.error || "Invalid reason" };
        }
        newReason = reasonRes.reason;
      } else if (newStatus === "blocked") {
        if (current.status === "blocked" && current.reason) {
          newReason = current.reason;
        } else {
          return { success: false, error: `Task ${u.id} cannot be marked blocked without a reason` };
        }
      }

      candidate[idx] = {
        id: current.id,
        text: newText,
        status: newStatus,
        ...(newReason ? { reason: newReason } : {}),
      };
    }

    const inProgressCount = candidate.filter((i) => i.status === "in_progress").length;
    if (inProgressCount > 1) {
      return { success: false, error: "At most one task can be in_progress at a time" };
    }

    return this.commitState(candidate);
  }

  public clear(): TodoMutationResult {
    return this.commitState([]);
  }

  public restoreFromBranch(branch: unknown[], notifyWarning?: (msg: string) => void): boolean {
    if (!Array.isArray(branch) || branch.length === 0) {
      this.items = [];
      return true;
    }

    let latestEntry: { data?: unknown } | null = null;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as { type?: string; customType?: string; data?: unknown };
      if (entry && entry.type === "custom" && entry.customType === "pi-todo-state") {
        latestEntry = entry;
        break;
      }
    }

    if (!latestEntry) {
      this.items = [];
      return true;
    }

    const data = latestEntry.data as { version?: unknown; items?: unknown };
    if (!data || typeof data !== "object" || data.version !== 1 || !Array.isArray(data.items)) {
      this.items = [];
      notifyWarning?.("Invalid todo state snapshot found in session; resetting state to empty.");
      return false;
    }

    const validation = validateSnapshotItems(data.items);
    if (!validation.valid || !validation.items) {
      this.items = [];
      notifyWarning?.(`Invalid todo snapshot: ${validation.error}; resetting state to empty.`);
      return false;
    }

    this.items = clone(validation.items);
    return true;
  }
}
