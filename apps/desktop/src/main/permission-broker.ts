import { randomUUID } from "node:crypto";
import type { PermissionPollResult, PermissionResponse } from "../shared/events.js";

export type { PermissionPollResult, PermissionResponse };

export interface CreateOptions {
  toolName: string;
  toolDetail?: string;
  sessionId?: string;
  rawPayload: Record<string, unknown>;
  /** Auto-expire after this many ms. Defaults to 120_000 (2 minutes). */
  timeoutMs?: number;
}

export interface CreateResult {
  id: string;
}

interface InternalState {
  id: string;
  status: "pending" | "approved" | "denied" | "expired";
  decision?: "allow" | "deny";
  reason?: string;
  toolName: string;
  toolDetail?: string;
  sessionId?: string;
  rawPayload: Record<string, unknown>;
  timestamp: number;
  /** Concurrent long-polling waiters. Each fires once with the final result. */
  listeners: Set<(result: PermissionPollResult) => void>;
  /** Auto-expire timer handle. */
  timeout: ReturnType<typeof setTimeout>;
  /** Cached final result, set on first resolution/expire. */
  final?: PermissionPollResult;
}

/** Sentinel for "poll timed out at the GET side, not the broker side". */
const POLL_TIMEOUT_RESULT: PermissionPollResult = { status: "expired", reason: "Poll timeout" };

/**
 * Permission broker — owns the in-memory state machine for /permission requests.
 *
 * Why a class instead of bare `pendingPermissions` Map:
 * - The previous design had two real crash paths (timeout callback, before-quit handler)
 *   that both relied on a per-pending `resolve` function being clean. GET long-polling
 *   chained wrapper functions on top of it, so by the time the broker reached the second
 *   crash path, `pending.resolve` was already a wrapper calling an undefined origResolve.
 *   This broker never exposes a `resolve` field on the pending state — it uses an internal
 *   `listeners` Set that N concurrent waiters can subscribe to without polluting each other.
 *
 * Lifecycle:
 *   create()  →  wait() / wait() / ...  →  respond() | timeout | shutdown()
 */
export class PermissionBroker {
  private readonly states = new Map<string, InternalState>();
  private readonly defaultTimeoutMs: number;

  constructor(opts: { defaultTimeoutMs?: number } = {}) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
  }

  /** Create a new pending permission. Starts an auto-expire timer. */
  create(opts: CreateOptions): CreateResult {
    const id = randomUUID();
    const state: InternalState = {
      id,
      status: "pending",
      toolName: opts.toolName,
      toolDetail: opts.toolDetail,
      sessionId: opts.sessionId,
      rawPayload: opts.rawPayload,
      timestamp: Date.now(),
      listeners: new Set(),
      timeout: undefined as unknown as ReturnType<typeof setTimeout>
    };
    state.timeout = setTimeout(() => this.expire(id, "Timeout"), opts.timeoutMs ?? this.defaultTimeoutMs);
    this.states.set(id, state);
    return { id };
  }

  /** Look up an in-flight or recently-finished permission. */
  get(id: string): Readonly<InternalState> | undefined {
    return this.states.get(id);
  }

  /**
   * Wait for the permission to resolve. Returns a cached final result if the
   * permission is already settled; otherwise subscribes a one-shot listener
   * and races a per-call poll timeout.
   *
   * Never touches the internal `resolve` function — that's the whole point.
   * This is what makes concurrent waiters safe.
   */
  async wait(id: string, pollTimeoutMs: number = 120_000): Promise<PermissionPollResult> {
    const state = this.states.get(id);
    if (!state) {
      return { status: "error", reason: "not_found" };
    }
    if (state.final) {
      return state.final;
    }

    return new Promise<PermissionPollResult>(resolve => {
      const settle = (result: PermissionPollResult) => {
        state.listeners.delete(settle);
        clearTimeout(pollTimer);
        resolve(result);
      };
      state.listeners.add(settle);

      const pollTimer = setTimeout(() => {
        state.listeners.delete(settle);
        resolve(POLL_TIMEOUT_RESULT);
      }, pollTimeoutMs);
    });
  }

  /**
   * Apply a user decision. Idempotent: a second call with the same id returns
   * `{ ok: false }` without re-firing listeners.
   */
  respond(response: PermissionResponse): { ok: boolean } {
    const state = this.states.get(response.id);
    if (!state || state.status !== "pending") {
      return { ok: false };
    }
    clearTimeout(state.timeout);
    const decision: "allow" | "deny" = response.decision;
    const status = decision === "allow" ? "approved" : "denied";
    const result: PermissionPollResult = {
      status,
      decision,
      reason: response.reason ?? (decision === "allow" ? "Approved via Clawd" : "Denied via Clawd")
    };
    this.finalize(state, result);
    return { ok: true };
  }

  /**
   * Expire every pending permission. Called from the Electron `before-quit`
   * handler. After shutdown, all subsequent `wait()` calls return the cached
   * expired result immediately. Safe to call multiple times.
   */
  shutdown(reason: string = "App quitting"): void {
    for (const state of Array.from(this.states.values())) {
      if (state.status !== "pending") continue;
      clearTimeout(state.timeout);
      this.finalize(state, { status: "expired", reason });
    }
    this.states.clear();
  }

  /** Number of currently pending permissions (for diagnostics / tests). */
  get size(): number {
    let n = 0;
    for (const s of this.states.values()) if (s.status === "pending") n++;
    return n;
  }

  // ---- internals ----

  private expire(id: string, reason: string): void {
    const state = this.states.get(id);
    if (!state || state.status !== "pending") return;
    this.finalize(state, { status: "expired", reason });
  }

  private finalize(state: InternalState, result: PermissionPollResult): void {
    state.status =
      result.status === "approved" ? "approved"
      : result.status === "denied" ? "denied"
      : result.status === "expired" ? "expired"
      : "pending";
    state.decision = result.decision;
    state.reason = result.reason;
    state.final = result;

    // Snapshot + clear listeners before firing, so a listener that re-subscribes
    // (or that synchronously throws) doesn't see a half-finalized state.
    const listeners = Array.from(state.listeners);
    state.listeners.clear();
    for (const fn of listeners) {
      try {
        fn(result);
      } catch {
        // listener errors must not poison the broker
      }
    }
  }
}
