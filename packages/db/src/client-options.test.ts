import { describe, expect, it } from "vitest";
import {
  DEFAULT_DATABASE_APPLICATION_NAME,
  DEFAULT_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  DEFAULT_DATABASE_IDLE_TIMEOUT_SECONDS,
  databaseClientOptionsFromEnv,
  postgresJsOptions,
  resolveDatabaseClientOptions,
} from "./client.js";
import { DEFAULT_LONG_TRANSACTION_WARN_MS } from "./transaction-guard.js";

describe("databaseClientOptionsFromEnv", () => {
  it("returns no options when nothing is set, preserving driver defaults", () => {
    expect(databaseClientOptionsFromEnv({})).toEqual({});
    expect(postgresJsOptions(databaseClientOptionsFromEnv({}))).toEqual({});
  });

  it("ignores empty values", () => {
    expect(
      databaseClientOptionsFromEnv({
        DATABASE_PREPARED_STATEMENTS: "",
        DATABASE_POOL_MAX: "",
      }),
    ).toEqual({});
  });

  it("parses prepared-statement toggles", () => {
    expect(databaseClientOptionsFromEnv({ DATABASE_PREPARED_STATEMENTS: "false" })).toEqual({ prepare: false });
    expect(databaseClientOptionsFromEnv({ DATABASE_PREPARED_STATEMENTS: "0" })).toEqual({ prepare: false });
    expect(databaseClientOptionsFromEnv({ DATABASE_PREPARED_STATEMENTS: "true" })).toEqual({ prepare: true });
    expect(databaseClientOptionsFromEnv({ DATABASE_PREPARED_STATEMENTS: "TRUE" })).toEqual({ prepare: true });
  });

  it("parses pool and timeout settings", () => {
    expect(
      databaseClientOptionsFromEnv({
        DATABASE_POOL_MAX: "25",
        DATABASE_IDLE_TIMEOUT_SECONDS: "60",
        DATABASE_CONNECT_TIMEOUT_SECONDS: "10",
        DATABASE_MAX_LIFETIME_SECONDS: "1800",
        DATABASE_APPLICATION_NAME: " paperclip-web ",
      }),
    ).toEqual({
      maxConnections: 25,
      idleTimeoutSeconds: 60,
      connectTimeoutSeconds: 10,
      maxLifetimeSeconds: 1800,
      applicationName: "paperclip-web",
    });
  });

  it("accepts DATABASE_IDLE_TIMEOUT_SECONDS=0 as an explicit opt-out of idle reaping", () => {
    expect(databaseClientOptionsFromEnv({ DATABASE_IDLE_TIMEOUT_SECONDS: "0" })).toEqual({ idleTimeoutSeconds: 0 });
  });

  it("rejects malformed values instead of silently ignoring them", () => {
    expect(() => databaseClientOptionsFromEnv({ DATABASE_PREPARED_STATEMENTS: "maybe" })).toThrow(
      /DATABASE_PREPARED_STATEMENTS/,
    );
    expect(() => databaseClientOptionsFromEnv({ DATABASE_POOL_MAX: "0" })).toThrow(/DATABASE_POOL_MAX/);
    expect(() => databaseClientOptionsFromEnv({ DATABASE_POOL_MAX: "-3" })).toThrow(/DATABASE_POOL_MAX/);
    expect(() => databaseClientOptionsFromEnv({ DATABASE_CONNECT_TIMEOUT_SECONDS: "1.5" })).toThrow(
      /DATABASE_CONNECT_TIMEOUT_SECONDS/,
    );
    expect(() => databaseClientOptionsFromEnv({ DATABASE_IDLE_TIMEOUT_SECONDS: "-1" })).toThrow(
      /DATABASE_IDLE_TIMEOUT_SECONDS/,
    );
    expect(() => databaseClientOptionsFromEnv({ DATABASE_IDLE_TIMEOUT_SECONDS: "abc" })).toThrow(
      /DATABASE_IDLE_TIMEOUT_SECONDS/,
    );
    expect(() => databaseClientOptionsFromEnv({ DATABASE_MAX_LIFETIME_SECONDS: "0" })).toThrow(
      /DATABASE_MAX_LIFETIME_SECONDS/,
    );
    expect(() => databaseClientOptionsFromEnv({ DATABASE_MAX_LIFETIME_SECONDS: "NaN" })).toThrow(
      /DATABASE_MAX_LIFETIME_SECONDS/,
    );
  });

  it("maps to postgres.js option names", () => {
    expect(
      postgresJsOptions({
        prepare: false,
        maxConnections: 25,
        idleTimeoutSeconds: 60,
        connectTimeoutSeconds: 10,
        maxLifetimeSeconds: 1800,
        applicationName: "paperclip-web",
      }),
    ).toEqual({
      prepare: false,
      max: 25,
      idle_timeout: 60,
      connect_timeout: 10,
      max_lifetime: 1800,
      connection: { application_name: "paperclip-web" },
    });
  });
});

describe("resolveDatabaseClientOptions", () => {
  it("reaps idle connections and names the pool when the environment sets nothing", () => {
    expect(resolveDatabaseClientOptions({})).toEqual({
      idleTimeoutSeconds: DEFAULT_DATABASE_IDLE_TIMEOUT_SECONDS,
      applicationName: DEFAULT_DATABASE_APPLICATION_NAME,
      idleInTransactionTimeoutMs: DEFAULT_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      longTransactionWarnMs: DEFAULT_LONG_TRANSACTION_WARN_MS,
    });
    expect(postgresJsOptions(resolveDatabaseClientOptions(databaseClientOptionsFromEnv({})))).toEqual({
      idle_timeout: DEFAULT_DATABASE_IDLE_TIMEOUT_SECONDS,
      connection: {
        application_name: DEFAULT_DATABASE_APPLICATION_NAME,
        idle_in_transaction_session_timeout: String(DEFAULT_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS),
      },
    });
  });

  it("keeps every explicit value, including an idle timeout of 0", () => {
    expect(
      resolveDatabaseClientOptions({
        maxConnections: 3,
        idleTimeoutSeconds: 0,
        applicationName: "paperclip-cli",
      }),
    ).toEqual({
      maxConnections: 3,
      idleTimeoutSeconds: 0,
      applicationName: "paperclip-cli",
      idleInTransactionTimeoutMs: DEFAULT_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      longTransactionWarnMs: DEFAULT_LONG_TRANSACTION_WARN_MS,
    });
    expect(postgresJsOptions(resolveDatabaseClientOptions({ idleTimeoutSeconds: 0 }))).toMatchObject({
      idle_timeout: 0,
    });
  });
});

describe("idle-in-transaction safeguard", () => {
  it("parses the env settings, with 0 meaning an explicit disable", () => {
    expect(
      databaseClientOptionsFromEnv({
        DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: "0",
        DATABASE_LONG_TRANSACTION_WARN_MS: "10000",
      }),
    ).toEqual({ idleInTransactionTimeoutMs: 0, longTransactionWarnMs: 10000 });
    expect(() => databaseClientOptionsFromEnv({ DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: "-1" })).toThrow(
      /DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS/,
    );
    // PostgreSQL rejects a startup value above INT_MAX ms, and Node fires an
    // overflowing setTimeout after 1ms.
    expect(() => databaseClientOptionsFromEnv({ DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: "2147483648" })).toThrow(
      /DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS must be at most/,
    );
    expect(() => databaseClientOptionsFromEnv({ DATABASE_LONG_TRANSACTION_WARN_MS: "2147483648" })).toThrow(
      /DATABASE_LONG_TRANSACTION_WARN_MS must be at most/,
    );
  });

  it("sends the timeout as a startup parameter, including an explicit 0", () => {
    // postgres.js drops falsy startup values, so 0 must travel as "0".
    expect(postgresJsOptions({ idleInTransactionTimeoutMs: 0 })).toEqual({
      connection: { idle_in_transaction_session_timeout: "0" },
    });
    expect(postgresJsOptions({})).toEqual({});
  });
});
