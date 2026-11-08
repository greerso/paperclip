// Diagnostics for leaked transactions. A transaction callback that awaits
// something that never settles leaves its backend `idle in transaction` and,
// with a bounded pool, eventually starves every other query. The server-side
// `idle_in_transaction_session_timeout` ends such a session, but the server log
// cannot say which code opened it. This records where each outermost
// transaction was opened and warns, with that stack, when one stays open.
type Connection = { transaction: (...args: any[]) => Promise<any> };

export const DEFAULT_LONG_TRANSACTION_WARN_MS = 30_000;
const STACK_FRAMES = 12;

export function installTransactionGuard<T extends Connection>(
  db: T,
  options: { warnAfterMs: number; label: string },
): T {
  if (options.warnAfterMs <= 0) return db;
  const transaction = db.transaction;
  db.transaction = async function guardedTransaction(this: T, callback: (...args: any[]) => Promise<any>, ...rest: any[]) {
    const holder: { stack?: string } = {};
    const previousLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = STACK_FRAMES;
    try { Error.captureStackTrace(holder, guardedTransaction); }
    finally { Error.stackTraceLimit = previousLimit; }
    const openedAt = Date.now();
    const timer = setTimeout(() => {
      process.emitWarning(
        `Database transaction on pool "${options.label}" open or queued for a connection for ${Date.now() - openedAt}ms\n${holder.stack ?? ""}`,
        { code: "PAPERCLIP_LONG_TRANSACTION" },
      );
    }, options.warnAfterMs);
    timer.unref();
    try { return await transaction.call(this, callback, ...rest); }
    finally { clearTimeout(timer); }
  } as T["transaction"];
  return db;
}
