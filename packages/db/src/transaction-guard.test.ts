import { afterEach, describe, expect, it, vi } from "vitest";
import { installTransactionGuard } from "./transaction-guard.js";

afterEach(() => vi.useRealTimers());

function fakeDb(run: (callback: () => Promise<unknown>) => Promise<unknown>) {
  return { transaction: async (callback: () => Promise<unknown>) => run(callback) };
}

describe("installTransactionGuard", () => {
  it("warns with the opening stack when a transaction stays open", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    let release!: () => void;
    const db = installTransactionGuard(
      fakeDb((callback) => callback()),
      { warnAfterMs: 1000, label: "test-pool" },
    );
    const pending = db.transaction(() => new Promise<void>((resolve) => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('pool "test-pool"');
    expect(warn.mock.calls[0]?.[1]).toEqual({ code: "PAPERCLIP_LONG_TRANSACTION" });
    release();
    await pending;
    warn.mockRestore();
  });

  it("stays silent for a transaction that finishes, or fails, in time", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const db = installTransactionGuard(
      fakeDb((callback) => callback()),
      { warnAfterMs: 1000, label: "test-pool" },
    );
    await db.transaction(async () => "ok");
    await expect(db.transaction(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(5000);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("is a no-op when disabled", () => {
    const db = fakeDb((callback) => callback());
    const original = db.transaction;
    expect(installTransactionGuard(db, { warnAfterMs: 0, label: "x" }).transaction).toBe(original);
  });
});
