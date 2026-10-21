export const MAX_ITEMS = 20;
export const MAX_TEXT = 160;
export const MAX_REASON = 240;

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled" | "blocked";

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
  errors?: string[];
}

function clone<T>(val: T): T {
  return JSON.parse(JSON.stringify(val));
}

/** Checks whether two todo item lists are identical in IDs, text, status, and reason. */
export function areTodoItemsEqual(a: readonly TodoItem[], b: readonly TodoItem[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const itemA = a[i];
    const itemB = b[i];
    if (
      itemA.id !== itemB.id ||
      itemA.text !== itemB.text ||
      itemA.status !== itemB.status ||
      itemA.reason !== itemB.reason
    ) {
      return false;
    }
  }
  return true;
}

function failure(errors: string[]): TodoMutationResult {
  return {
    success: false,
    error: errors.length === 1
      ? errors[0]
      : `Validation failed with ${errors.length} errors: ${errors.join("; ")}`,
    errors,
  };
}

export function isValidStatus(status: unknown): status is TodoStatus {
  return (
    status === "pending" ||
    status === "in_progress" ||
    status === "completed" ||
    status === "cancelled" ||
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

export function validateSnapshotItems(
  items: unknown
): { valid: boolean; items?: TodoItem[]; error?: string; errors?: string[] } {
  if (!Array.isArray(items)) {
    const error = "Items must be an array";
    return { valid: false, error, errors: [error] };
  }
  if (items.length > MAX_ITEMS) {
    const error = `Todo list cannot exceed ${MAX_ITEMS} items`;
    return { valid: false, error, errors: [error] };
  }

  const result: TodoItem[] = [];
  const seenIds = new Set<number>();
  const errors: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    if (!raw || typeof raw !== "object") {
      errors.push(`Item at index ${i} is malformed`);
      continue;
    }

    const record = raw as Record<string, unknown>;
    const errorStart = errors.length;
    const rawId = record.id;
    let id: number | undefined;
    let label = `Item at index ${i}`;

    if (typeof rawId === "number" && Number.isInteger(rawId) && rawId === i + 1) {
      id = rawId;
      label = `Item ${rawId}`;
      if (seenIds.has(rawId)) {
        errors.push(`Duplicate item id ${rawId}`);
      } else {
        seenIds.add(rawId);
      }
    } else {
      errors.push(`Item at index ${i} must have sequential id ${i + 1}`);
    }

    const textRes = validateItemText(record.text);
    if (!textRes.valid || !textRes.text) {
      errors.push(`${label}: ${textRes.error || "text is invalid"}`);
    }

    const rawStatus = record.status;
    let status: TodoStatus | undefined;
    if (!isValidStatus(rawStatus)) {
      errors.push(`${label} has invalid status '${String(rawStatus)}'`);
    } else {
      status = rawStatus;
      let reason: string | undefined;
      const rawReason = record.reason;

      if (status === "blocked") {
        const reasonRes = normalizeReason(status, rawReason);
        if (!reasonRes.valid || !reasonRes.reason) {
          const detail = rawReason === undefined
            ? "missing non-blank reason"
            : `has invalid reason: ${reasonRes.error ?? "unknown error"}`;
          errors.push(`${label} is blocked but ${detail}`);
        } else {
          reason = reasonRes.reason;
        }
      } else if (rawReason !== undefined) {
        const reasonRes = normalizeReason(status, rawReason);
        if (!reasonRes.valid) {
          errors.push(`${label} has invalid reason: ${reasonRes.error}`);
        }
      }

      if (errors.length === errorStart && id !== undefined && textRes.text) {
        result.push({
          id,
          text: textRes.text,
          status,
          ...(reason ? { reason } : {}),
        });
      }
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      error: errors.length === 1
        ? errors[0]
        : `Validation failed with ${errors.length} errors: ${errors.join("; ")}`,
      errors,
    };
  }

  const inProgress = result.filter((item) => item.status === "in_progress");
  if (inProgress.length > 1) {
    const ids = inProgress.map((item) => `#${item.id}`).join(", ");
    const error = `At most one task can be in_progress at a time (found ${inProgress.length}: ${ids})`;
    return { valid: false, error, errors: [error] };
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
    if (areTodoItemsEqual(this.items, candidate)) {
      return { success: true };
    }

    const snapshot: TodoStateSnapshot = {
      version: 1,
      items: clone(candidate),
    };

    if (this.appendEntryFn) {
      try {
        this.appendEntryFn("pi-todo-state", snapshot);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return failure([`Persistence error: ${message}`]);
      }
    }

    this.items = candidate;
    return { success: true };
  }

  public set(rawItems: TodoSetItemInput[]): TodoMutationResult {
    if (!Array.isArray(rawItems)) {
      return failure(["Items must be an array"]);
    }
    if (rawItems.length > MAX_ITEMS) {
      return failure([`Cannot set more than ${MAX_ITEMS} items`]);
    }

    if (rawItems.length === 0) {
      return this.clear();
    }

    const candidate: TodoItem[] = [];
    const errors: string[] = [];

    for (let i = 0; i < rawItems.length; i++) {
      const raw = rawItems[i];
      const label = `Item ${i + 1}`;
      if (!raw || typeof raw !== "object") {
        errors.push(`Item at index ${i} is malformed`);
        continue;
      }

      const errorStart = errors.length;
      const textRes = validateItemText(raw.text);
      const text = textRes.text;
      if (!textRes.valid || !text) {
        errors.push(`${label}: ${textRes.error || "text is invalid"}`);
      }

      const status = raw.status === undefined ? "pending" : raw.status;
      if (!isValidStatus(status)) {
        errors.push(`${label} has invalid status '${String(status)}'`);
        continue;
      }

      let reason: string | undefined;
      if (raw.reason !== undefined) {
        const reasonRes = normalizeReason(status, raw.reason);
        if (!reasonRes.valid) {
          errors.push(`${label}: ${reasonRes.error || "Invalid reason"}`);
        } else {
          reason = reasonRes.reason;
        }
      } else if (status === "blocked") {
        errors.push(`${label}: Blocked status requires a reason`);
      }

      if (errors.length === errorStart && text) {
        candidate.push({
          id: i + 1,
          text,
          status,
          ...(reason ? { reason } : {}),
        });
      }
    }

    if (errors.length > 0) {
      return failure(errors);
    }

    const inProgress = candidate.filter((item) => item.status === "in_progress");
    if (inProgress.length > 1) {
      const ids = inProgress.map((item) => `#${item.id}`).join(", ");
      return failure([`At most one task can be in_progress at a time (found ${inProgress.length}: ${ids})`]);
    }

    return this.commitState(candidate);
  }

  public update(updates: TodoUpdateItemInput[]): TodoMutationResult {
    if (!Array.isArray(updates) || updates.length === 0) {
      return failure(["Updates array cannot be empty"]);
    }

    const envelopeErrors: string[] = [];
    const seenIds = new Set<number>();
    for (let i = 0; i < updates.length; i++) {
      const u = updates[i];
      if (!u || typeof u !== "object" || typeof u.id !== "number" || !Number.isInteger(u.id) || u.id <= 0) {
        envelopeErrors.push(`Update at index ${i} must include a positive integer id`);
        continue;
      }
      if (seenIds.has(u.id)) {
        envelopeErrors.push(`Duplicate update for task id ${u.id}`);
      } else {
        seenIds.add(u.id);
      }
    }
    if (envelopeErrors.length > 0) {
      return failure(envelopeErrors);
    }

    const candidate = clone(this.items);
    const errors: string[] = [];

    for (const u of updates) {
      const idx = candidate.findIndex((item) => item.id === u.id);
      if (idx === -1) {
        errors.push(`Unknown task id ${u.id}`);
        continue;
      }

      const current = candidate[idx];
      const updateErrors: string[] = [];

      let newText = current.text;
      if (u.text !== undefined) {
        const textRes = validateItemText(u.text);
        if (!textRes.valid || !textRes.text) {
          updateErrors.push(textRes.error || "text is invalid");
        } else {
          newText = textRes.text;
        }
      }

      const newStatus = u.status !== undefined ? u.status : current.status;
      let newReason: string | undefined;
      if (!isValidStatus(newStatus)) {
        updateErrors.push(`Invalid status '${String(newStatus)}'`);
      } else if (u.reason !== undefined) {
        const reasonRes = normalizeReason(newStatus, u.reason);
        if (!reasonRes.valid) {
          updateErrors.push(reasonRes.error || "Invalid reason");
        } else {
          newReason = reasonRes.reason;
        }
      } else if (newStatus === "blocked") {
        if (current.status === "blocked" && current.reason) {
          newReason = current.reason;
        } else {
          updateErrors.push("Cannot mark blocked without a reason");
        }
      }

      if (updateErrors.length > 0) {
        errors.push(...updateErrors.map((msg) => `Task ${u.id}: ${msg}`));
        continue;
      }

      candidate[idx] = {
        id: current.id,
        text: newText,
        status: newStatus,
        ...(newReason ? { reason: newReason } : {}),
      };
    }

    if (errors.length > 0) {
      return failure(errors);
    }

    const inProgress = candidate.filter((item) => item.status === "in_progress");
    if (inProgress.length > 1) {
      const ids = inProgress.map((item) => `#${item.id}`).join(", ");
      return failure([`At most one task can be in_progress at a time (found ${inProgress.length}: ${ids})`]);
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
