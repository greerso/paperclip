import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  buildIssueBlockersResolvedWakeIdempotencyKey,
  buildIssueBlockersResolvedWakeStateKey,
  buildIssueBlockersResolvedWakeStateKeyWithoutCycle,
  findExistingIssueBlockersResolvedWakeForReadyState,
  findIssueBlockersResolvedWakeSuppression,
  shouldWakeOnRestoredBlockedDependency,
  suppressionForBlockersResolvedWakeHistory,
} from "./issue-dependency-wakeups.js";

const dependentIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const blockerIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const companyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const firstCycle = new Date("2026-04-01T12:00:00.000Z");
const secondCycle = new Date("2026-08-01T09:30:00.000Z");

type WakeRow = {
  id: string;
  status: string;
  idempotencyKey: string | null;
  requestedAt: Date;
};

function dbWithWakes(rows: WakeRow[]): Db {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve(rows);
            },
          };
        },
      };
    },
  } as unknown as Db;
}

describe("buildIssueBlockersResolvedWakeStateKey", () => {
  it("is identical for the same dependent, blockers, and blockedTransitionAt", () => {
    const first = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle,
    });
    const second = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle.toISOString(),
    });
    expect(first).toBe(second);
    expect(first).toContain(dependentIssueId);
  });

  it("changes when blockedTransitionAt changes", () => {
    const first = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle,
    });
    const second = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: secondCycle,
    });
    expect(first).not.toBe(second);
  });

  it("hashes a null cycle as none and differs from any timestamp", () => {
    const noneKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: null,
    });
    const omittedKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const datedKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle,
    });
    expect(noneKey).toBe(omittedKey);
    expect(noneKey).not.toBe(datedKey);
    expect(noneKey).not.toBe(
      buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
        dependentIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
  });
});

describe("findExistingIssueBlockersResolvedWakeForReadyState", () => {
  const readyState = {
    companyId,
    dependentIssueId,
    blockerIssueIds: [blockerIssueId],
    blockedTransitionAt: secondCycle,
  };

  it("suppresses a completed wake on the cycle-aware state key", async () => {
    const cycleKey = buildIssueBlockersResolvedWakeStateKey(readyState);
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-cycle",
          status: "completed",
          idempotencyKey: cycleKey,
          requestedAt: secondCycle,
        },
      ]),
      readyState,
    );
    expect(existing?.id).toBe("wake-cycle");
  });

  it("does not let a completed old-key wake from a previous blocked cycle suppress", async () => {
    const oldKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-old-previous-cycle",
          status: "completed",
          idempotencyKey: oldKey,
          requestedAt: firstCycle,
        },
      ]),
      readyState,
    );
    expect(existing).toBeNull();
  });

  it("suppresses a completed old-key wake requested at or after blockedTransitionAt", async () => {
    const oldKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-old-same-cycle",
          status: "completed",
          idempotencyKey: oldKey,
          requestedAt: secondCycle,
        },
      ]),
      readyState,
    );
    expect(existing?.id).toBe("wake-old-same-cycle");
  });

  it("suppresses a completed old-key wake when blockedTransitionAt is null", async () => {
    const oldKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-old-no-cycle",
          status: "completed",
          idempotencyKey: oldKey,
          requestedAt: firstCycle,
        },
      ]),
      {
        companyId,
        dependentIssueId,
        blockerIssueIds: [blockerIssueId],
        blockedTransitionAt: null,
      },
    );
    expect(existing?.id).toBe("wake-old-no-cycle");
  });

  it("suppresses an in-flight old-key wake across a later blocked cycle", async () => {
    const oldKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-old-queued",
          status: "queued",
          idempotencyKey: oldKey,
          requestedAt: firstCycle,
        },
      ]),
      readyState,
    );
    expect(existing?.id).toBe("wake-old-queued");
  });

  it("keeps legacy per-edge matching in-flight only", async () => {
    const legacyKey = buildIssueBlockersResolvedWakeIdempotencyKey({
      dependentIssueId,
      resolvedBlockerIssueId: blockerIssueId,
    });
    const inFlight = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-legacy-claimed",
          status: "claimed",
          idempotencyKey: legacyKey,
          requestedAt: firstCycle,
        },
      ]),
      readyState,
    );
    expect(inFlight?.id).toBe("wake-legacy-claimed");

    const completed = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-legacy-completed",
          status: "completed",
          idempotencyKey: legacyKey,
          requestedAt: firstCycle,
        },
      ]),
      readyState,
    );
    expect(completed).toBeNull();
  });
});

const assigneeId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const otherAgentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const now = new Date("2026-11-05T16:00:00.000Z");

function restoredInput(
  overrides: Partial<Parameters<typeof shouldWakeOnRestoredBlockedDependency>[0]> = {},
) {
  return {
    previousStatus: "in_progress",
    nextStatus: "blocked",
    previousAssigneeAgentId: assigneeId,
    nextAssigneeAgentId: assigneeId,
    blockedByIssueIds: undefined as readonly string[] | undefined,
    existingBlockerIssueIds: [blockerIssueId],
    actorType: "agent",
    actorAgentId: assigneeId,
    ...overrides,
  };
}

describe("shouldWakeOnRestoredBlockedDependency", () => {
  it("does not wake the assignee for an unchanged self-block", () => {
    expect(shouldWakeOnRestoredBlockedDependency(restoredInput())).toBe(false);
    expect(shouldWakeOnRestoredBlockedDependency(restoredInput({
      blockedByIssueIds: [blockerIssueId],
    }))).toBe(false);
    expect(shouldWakeOnRestoredBlockedDependency(restoredInput({
      blockedByIssueIds: [blockerIssueId, blockerIssueId],
    }))).toBe(false);
  });

  it("wakes a board re-block, another agent, a reassignment, and a real set change", () => {
    expect(shouldWakeOnRestoredBlockedDependency(restoredInput({
      actorType: "user",
      actorAgentId: null,
    }))).toBe(true);
    expect(shouldWakeOnRestoredBlockedDependency(restoredInput({
      actorAgentId: otherAgentId,
    }))).toBe(true);
    expect(shouldWakeOnRestoredBlockedDependency(restoredInput({
      previousAssigneeAgentId: otherAgentId,
      actorType: "user",
      actorAgentId: null,
    }))).toBe(true);
    expect(shouldWakeOnRestoredBlockedDependency(restoredInput({
      blockedByIssueIds: ["ffffffff-ffff-4fff-8fff-ffffffffffff"],
    }))).toBe(true);
  });
});

describe("suppressionForBlockersResolvedWakeHistory", () => {
  const wake = (
    overrides: Partial<{ status: string; requestedAt: Date; payload: unknown }> = {},
  ) => ({
    status: "completed",
    requestedAt: new Date("2026-11-05T15:30:00.000Z"),
    payload: {
      issueId: dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    },
    ...overrides,
  });

  const base = {
    dependentIssueId,
    blockerIssueIds: [blockerIssueId],
    now,
    pendingHumanOnlyInteraction: false,
    pendingLinkedApproval: false,
  };

  it("treats a completed same-set wake in the last 24h as covering blockers_restored", () => {
    expect(suppressionForBlockersResolvedWakeHistory({
      ...base,
      source: "issue.blockers_restored",
      wakes: [wake({ requestedAt: new Date("2026-11-04T16:30:00.000Z") })],
    })).toEqual({ reason: "recent_same_set" });
  });

  it("does not let that 24h wake block a blocker moving to done", () => {
    expect(suppressionForBlockersResolvedWakeHistory({
      ...base,
      source: "issue.blockers_resolved",
      wakes: [wake()],
    })).toBeNull();
  });

  it("suppresses while a human_only card or a linked approval is pending", () => {
    expect(suppressionForBlockersResolvedWakeHistory({
      ...base,
      source: "issue.blockers_resolved",
      wakes: [],
      pendingHumanOnlyInteraction: true,
    })).toEqual({ reason: "human_gate" });
    expect(suppressionForBlockersResolvedWakeHistory({
      ...base,
      source: "issue_graph_liveness.backstop",
      wakes: [],
      pendingLinkedApproval: true,
    })).toEqual({ reason: "human_gate" });
  });

  it("holds the cap at 3 counting wakes in the rolling hour", () => {
    const wakes = [0, 1, 2].map(() => wake({
      payload: { issueId: dependentIssueId, blockerIssueIds: ["other"] },
    }));
    expect(suppressionForBlockersResolvedWakeHistory({
      ...base,
      source: "issue.blockers_resolved",
      wakes,
    })).toEqual({ reason: "hourly_cap", count: 3 });
    expect(suppressionForBlockersResolvedWakeHistory({
      ...base,
      source: "issue.blockers_resolved",
      wakes: wakes.slice(0, 2),
    })).toBeNull();
    expect(suppressionForBlockersResolvedWakeHistory({
      ...base,
      source: "issue.blockers_resolved",
      wakes: [
        wake({ status: "skipped" }),
        wake({ status: "failed" }),
        wake({ status: "cancelled" }),
        wake({ requestedAt: new Date("2026-11-05T14:00:00.000Z") }),
      ],
    })).toBeNull();
  });
});

function isDrizzleParam(value: object): boolean {
  const ctor = value.constructor as unknown as { name?: string; [key: symbol]: unknown };
  return ctor[Symbol.for("drizzle:entityKind")] === "Param" || ctor.name === "Param";
}

function boundParamValues(condition: unknown): unknown[] {
  const values: unknown[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (isDrizzleParam(value)) {
      values.push((value as { value: unknown }).value);
      return;
    }
    for (const item of Object.values(value)) walk(item);
  };
  walk(condition);
  return values;
}

/** Returns the legacy card only when the interaction filter binds `board_only`. */
function dbReturningHumanGateOnlyForLegacyBoardPolicy(): Db {
  return {
    select() {
      let rows: unknown[] = [];
      const chain = {
        from() {
          return chain;
        },
        innerJoin() {
          return chain;
        },
        where(condition: unknown) {
          const params = boundParamValues(condition);
          const matchesLegacyHumanGate = params.some(
            (value) => Array.isArray(value) && value.includes("board_only") && value.includes("human_only"),
          ) || (params.includes("board_only") && params.includes("human_only"));
          rows = matchesLegacyHumanGate ? [{ id: "legacy-board-only-card" }] : [];
          return chain;
        },
        limit() {
          return Promise.resolve(rows);
        },
        then(resolve: (value: unknown) => unknown, reject?: (err: unknown) => unknown) {
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return chain;
    },
  } as unknown as Db;
}

function scriptedDb(pages: unknown[][]): Db {
  let call = 0;
  return {
    select() {
      const rows = pages[call++] ?? [];
      const chain = {
        from() {
          return chain;
        },
        innerJoin() {
          return chain;
        },
        where() {
          return chain;
        },
        limit() {
          return Promise.resolve(rows);
        },
        then(resolve: (value: unknown) => unknown, reject?: (err: unknown) => unknown) {
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return chain;
    },
  } as unknown as Db;
}

describe("findIssueBlockersResolvedWakeSuppression", () => {
  it("suppresses when the only pending card is stored as board_only", async () => {
    const decision = await findIssueBlockersResolvedWakeSuppression(
      dbReturningHumanGateOnlyForLegacyBoardPolicy(),
      {
        companyId,
        dependentIssueId,
        blockerIssueIds: [blockerIssueId],
        source: "issue.blockers_resolved",
        now,
      },
    );
    expect(decision).toEqual({ reason: "human_gate" });
  });

  it("reads a pending human_only interaction and a pending approval as the human gate", async () => {
    const human = await findIssueBlockersResolvedWakeSuppression(scriptedDb([[], [{ id: "card" }], []]), {
      companyId,
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      source: "issue.blockers_resolved",
      now,
    });
    const approval = await findIssueBlockersResolvedWakeSuppression(scriptedDb([[], [], [{ id: "approval" }]]), {
      companyId,
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      source: "workspace.finalize",
      now,
    });
    expect(human).toEqual({ reason: "human_gate" });
    expect(approval).toEqual({ reason: "human_gate" });
  });

  it("counts three recent wakes as the cap for the backstop", async () => {
    const recent = new Date("2026-11-05T15:50:00.000Z");
    const wakes = [0, 1, 2].map(() => ({
      status: "queued",
      requestedAt: recent,
      payload: { issueId: dependentIssueId, blockerIssueIds: [blockerIssueId] },
    }));
    const decision = await findIssueBlockersResolvedWakeSuppression(scriptedDb([wakes, [], []]), {
      companyId,
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      source: "issue_graph_liveness.backstop",
      now,
    });
    expect(decision).toEqual({ reason: "hourly_cap", count: 3 });
  });
});
