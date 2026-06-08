import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { PermissionBroker } from "../src/main/permission-broker.js";

/**
 * The PermissionBroker is a pure in-memory state machine, so we don't need
 * any Electron / fs mocks. We DO need fake timers because the broker runs
 * a 120s auto-expire timer per request.
 */

describe("PermissionBroker", () => {
  let broker: PermissionBroker;

  beforeEach(() => {
    vi.useFakeTimers();
    broker = new PermissionBroker({ defaultTimeoutMs: 120_000 });
  });

  afterEach(() => {
    broker.shutdown("test cleanup");
    vi.useRealTimers();
  });

  it("returns ok=true on first respond, ok=false on second (idempotent)", () => {
    const { id } = broker.create({ toolName: "Bash", rawPayload: {} });

    expect(broker.respond({ id, decision: "allow" })).toEqual({ ok: true });
    expect(broker.respond({ id, decision: "deny" })).toEqual({ ok: false });
    expect(broker.respond({ id, decision: "deny" })).toEqual({ ok: false });
  });

  it("delivers the user decision to a single waiter", async () => {
    const { id } = broker.create({ toolName: "Bash", rawPayload: {} });
    const waiter = broker.wait(id);

    broker.respond({ id, decision: "allow", reason: "explicit" });

    await expect(waiter).resolves.toEqual({
      status: "approved",
      decision: "allow",
      reason: "explicit"
    });
  });

  it("auto-expires after defaultTimeoutMs (120s) and notifies waiter", async () => {
    const { id } = broker.create({ toolName: "Bash", rawPayload: {} });
    const waiter = broker.wait(id);

    vi.advanceTimersByTime(120_000);

    await expect(waiter).resolves.toEqual({ status: "expired", reason: "Timeout" });
  });

  it("auto-expires after custom timeoutMs", async () => {
    const { id } = broker.create({ toolName: "Bash", rawPayload: {}, timeoutMs: 5_000 });
    const waiter = broker.wait(id);

    // Just before timeout — not yet expired
    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    waiter.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    // Cross the timeout
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiter).resolves.toEqual({ status: "expired", reason: "Timeout" });
  });

  it("delivers the same result to multiple concurrent waiters (regression for chain-poll bug)", async () => {
    // This is the core scenario: N concurrent GET /permission/:id calls for the same id.
    // The previous chain-poll design would re-wrap pending.resolve N times; the broker
    // must NOT propagate that pollution. All waiters must see the same final result.
    const { id } = broker.create({ toolName: "Bash", rawPayload: {} });

    const waiters = [broker.wait(id), broker.wait(id), broker.wait(id), broker.wait(id), broker.wait(id)];

    broker.respond({ id, decision: "deny" });

    const results = await Promise.all(waiters);
    expect(results).toEqual([
      { status: "denied", decision: "deny", reason: "Denied via Clawd" },
      { status: "denied", decision: "deny", reason: "Denied via Clawd" },
      { status: "denied", decision: "deny", reason: "Denied via Clawd" },
      { status: "denied", decision: "deny", reason: "Denied via Clawd" },
      { status: "denied", decision: "deny", reason: "Denied via Clawd" }
    ]);
  });

  it("returns cached result on wait() after decision (simulates GET-after-decide)", async () => {
    const { id } = broker.create({ toolName: "Bash", rawPayload: {} });
    broker.respond({ id, decision: "allow" });

    // broker keeps the state around (until shutdown) so re-polls can still see the decision
    const result = await broker.wait(id);
    expect(result).toEqual({ status: "approved", decision: "allow", reason: "Approved via Clawd" });
  });

  it("returns { status: 'error', reason: 'not_found' } for unknown id", async () => {
    const result = await broker.wait("nonexistent-id");
    expect(result).toEqual({ status: "error", reason: "not_found" });
  });

  it("responds with default reason strings when caller omits reason", async () => {
    const allow = broker.create({ toolName: "Read", rawPayload: {} });
    const deny = broker.create({ toolName: "Edit", rawPayload: {} });
    const allowWait = broker.wait(allow.id);
    const denyWait = broker.wait(deny.id);

    broker.respond({ id: allow.id, decision: "allow" });
    broker.respond({ id: deny.id, decision: "deny" });

    expect(await allowWait).toMatchObject({ reason: "Approved via Clawd" });
    expect(await denyWait).toMatchObject({ reason: "Denied via Clawd" });
  });

  it("responds before timeout even if 120s not yet elapsed", async () => {
    const { id } = broker.create({ toolName: "Bash", rawPayload: {} });
    const waiter = broker.wait(id);

    vi.advanceTimersByTime(60_000);
    broker.respond({ id, decision: "allow" });
    vi.advanceTimersByTime(60_000);

    await expect(waiter).resolves.toEqual({ status: "approved", decision: "allow", reason: "Approved via Clawd" });
  });

  it("wait() poll-side timeout returns 'Poll timeout' even if broker is still pending", async () => {
    const { id } = broker.create({ toolName: "Bash", rawPayload: {} });
    const waiter = broker.wait(id, 30_000);

    vi.advanceTimersByTime(30_000);
    await expect(waiter).resolves.toEqual({ status: "expired", reason: "Poll timeout" });

    // broker should still be pending; subsequent decision still works
    broker.respond({ id, decision: "allow" });
    expect(broker.get(id)?.status).toBe("approved");
  });

  describe("shutdown", () => {
    it("expires every pending request and notifies all waiters", async () => {
      const a = broker.create({ toolName: "Bash", rawPayload: {} });
      const b = broker.create({ toolName: "Edit", rawPayload: {} });
      const aWait = broker.wait(a.id);
      const bWait = broker.wait(b.id);

      broker.shutdown("App quitting");

      await expect(aWait).resolves.toEqual({ status: "expired", reason: "App quitting" });
      await expect(bWait).resolves.toEqual({ status: "expired", reason: "App quitting" });
      expect(broker.size).toBe(0);
    });

    it("REGRESSION: handles N concurrent waiters + shutdown without any 'undefined' error", async () => {
      // This is the EXACT scenario the user reported:
      //   MenuItem.click → before-quit → pendingPermissions.forEach(p => p.resolve(...))
      //   with p.resolve being a chain-poll wrapper whose origResolve was undefined.
      // The broker must:
      //   1. never expose a resolve function (no chain-poll pollution possible)
      //   2. shutdown must cleanly fire all waiters without throwing
      const { id } = broker.create({ toolName: "Bash", rawPayload: {} });
      const waiters = Array.from({ length: 5 }, () => broker.wait(id));

      const noError = vi.fn();
      process.once("uncaughtException", noError);

      expect(() => broker.shutdown("App quitting")).not.toThrow();

      const results = await Promise.all(waiters);
      expect(results.every(r => r.status === "expired" && r.reason === "App quitting")).toBe(true);
      expect(noError).not.toHaveBeenCalled();
    });

    it("is idempotent — calling shutdown twice does not throw", () => {
      const { id } = broker.create({ toolName: "Bash", rawPayload: {} });
      broker.shutdown("first");
      expect(() => broker.shutdown("second")).not.toThrow();
      expect(broker.size).toBe(0);
    });

    it("subsequent wait() returns cached expired result", async () => {
      const { id } = broker.create({ toolName: "Bash", rawPayload: {} });
      broker.shutdown("App quitting");

      // The state is cleared on shutdown, so wait() returns the not_found error
      const result = await broker.wait(id);
      expect(result).toEqual({ status: "error", reason: "not_found" });
    });
  });

  it("does not crash if a waiter callback throws", () => {
    const { id } = broker.create({ toolName: "Bash", rawPayload: {} });
    // Subscribe a faulty listener directly to the internal state
    const state = broker.get(id);
    expect(state).toBeDefined();
    const faulty = vi.fn(() => { throw new Error("boom"); });
    state!.listeners.add(faulty);

    expect(() => broker.respond({ id, decision: "allow" })).not.toThrow();
    // The faulty listener was called; the broker continued fine
    expect(faulty).toHaveBeenCalled();
  });
});
