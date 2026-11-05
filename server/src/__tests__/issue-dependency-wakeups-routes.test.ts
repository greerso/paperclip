import { getTableName } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISSUE_BLOCKERS_RESOLVED_WAKE_SUPPRESSED_ACTION,
  buildIssueBlockersResolvedWakeStateKey,
} from "../services/issue-dependency-wakeups.ts";

// The first test in this suite imports the large `routes/issues.ts` module
// through `vi.importActual` inside `createApp`. `vi.resetModules()` in
// `beforeEach` forces a fresh import each test, so the first test pays the
// one-time transform and execution cost of that module. Locally the first
// test takes about 3.7s while the later tests take about 0.13s each. Under
// the loaded serial shard (maxWorkers=1) this cold-start can cross vitest's
// default 5000ms test timeout and produce a flaky "Test timed out in 5000ms"
// failure. Give the suite generous headroom, far above the observed cold-start
// yet still below the 30s hook timeout.
vi.setConfig({ testTimeout: 30000 });

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockFindExistingIssueBlockersResolvedWakeForReadyState = vi.hoisted(() => vi.fn(async () => null));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  getDependencyReadiness: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
  checkout: vi.fn(),
  assertCheckoutOwner: vi.fn(async () => ({})),
  addComment: vi.fn(async (_id: string, body: string) => ({
    id: "comment-1",
    body,
    createdAt: new Date().toISOString(),
  })),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    decide: vi.fn(async (input: { action: string }) => ({
      allowed:
        input.action === "issue:read" ||
        input.action === "issue:mutate" ||
        input.action === "issue:comment" ||
        input.action === "project:read" ||
        input.action === "tasks:manage_active_checkouts",
      action: input.action,
      reason: "allow_test_read",
      explanation: "The fixture actor can read the task.",
    })),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

vi.mock("../services/issue-dependency-wakeups.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issue-dependency-wakeups.js")>(
    "../services/issue-dependency-wakeups.js",
  );
  return {
    ...actual,
    findExistingIssueBlockersResolvedWakeForReadyState:
      mockFindExistingIssueBlockersResolvedWakeForReadyState,
  };
});

const boardActor = {
  type: "board" as const,
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit" as const,
  isInstanceAdmin: false,
};

function agentActor(agentId: string) {
  return {
    type: "agent" as const,
    agentId,
    companyId: "company-1",
    companyIds: ["company-1"],
    source: "agent_jwt" as const,
    runId: "44444444-4444-4444-8444-444444444444",
    isInstanceAdmin: false,
  };
}

function tableNameOf(table: unknown): string {
  try {
    return getTableName(table as never);
  } catch {
    return "";
  }
}

async function createApp(options?: {
  actor?: Record<string, unknown>;
  rowsForTable?: (tableName: string) => unknown[] | null;
}) {
  const emptyRows: unknown[] = [];
  const rowsFor = (table: unknown) => options?.rowsForTable?.(tableNameOf(table)) ?? emptyRows;
  // Thenable proxy so route queries can chain where/orderBy/for/limit without
  // each new call site teaching the fixture another method name.
  const chainFor = (rows: unknown[]) => {
    const target: Record<string | symbol, unknown> = {
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (err: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject),
      catch: (reject: (err: unknown) => unknown) => Promise.resolve(rows).catch(reject),
      finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
    };
    const query: unknown = new Proxy(target, {
      get(obj, prop) {
        if (prop in obj) return obj[prop];
        return () => query;
      },
    });
    return query;
  };
  const routeDb = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => chainFor(rowsFor(table))),
    })),
    update: vi.fn(() => chainFor(emptyRows)),
    insert: vi.fn(() => chainFor(emptyRows)),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(routeDb),
  };
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = options?.actor ?? boardActor;
    next();
  });
  app.use("/api", issueRoutes(routeDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue dependency wakeups in issue routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockFindExistingIssueBlockersResolvedWakeForReadyState.mockResolvedValue(null);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "issue-1",
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.checkout.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({});
    mockIssueService.addComment.mockReset();
    mockIssueService.addComment.mockImplementation(async (_id: string, body: string) => ({
      id: "comment-1",
      body,
      createdAt: new Date().toISOString(),
    }));
  });

  it("wakes dependents when the final blocker transitions to done", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "done",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: ["issue-1", "issue-3"],
      },
    ]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: "issue-2",
            resolvedBlockerIssueId: "issue-1",
          }),
        }),
      );
    });
  });

  it("wakes an assigned blocked issue when blockers are applied after the blocker is already done", async () => {
    const parentIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue({
      id: parentIssueId,
      companyId: "company-1",
      identifier: "PAP-200",
      title: "Blocked after completion",
      description: null,
      status: "todo",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: parentIssueId,
      companyId: "company-1",
      identifier: "PAP-200",
      title: "Blocked after completion",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: parentIssueId,
      blockerIssueIds: [childIssueId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${parentIssueId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: [childIssueId],
        unblockDescriptor: { owner: "board", action: "Review the restored dependency" },
      });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: parentIssueId,
            resolvedBlockerIssueId: childIssueId,
            mutation: "blocked_dependency_restored",
          }),
          contextSnapshot: expect.objectContaining({
            source: "issue.blockers_restored",
          }),
        }),
      );
    });
  });

  it("wakes the parent when all direct children become terminal", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "in_progress",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "done",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-9",
      childIssueIds: ["child-0", "child-1"],
      childIssueSummaries: [
        {
          id: "child-0",
          identifier: "PAP-100",
          title: "First child",
          status: "done",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          updatedAt: new Date("2026-04-18T12:00:00.000Z"),
          summary: "First child finished.",
        },
        {
          id: "child-1",
          identifier: "PAP-101",
          title: "Last child",
          status: "done",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          updatedAt: new Date("2026-04-18T12:05:00.000Z"),
          summary: "Last child finished.",
        },
      ],
      childIssueSummaryTruncated: false,
    });

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-9",
        expect.objectContaining({
          reason: "issue_children_completed",
          payload: expect.objectContaining({
            issueId: "parent-1",
            completedChildIssueId: "child-1",
            childIssueSummaries: expect.arrayContaining([
              expect.objectContaining({ identifier: "PAP-101", summary: "Last child finished." }),
            ]),
          }),
          contextSnapshot: expect.objectContaining({
            childIssueSummaries: expect.arrayContaining([
              expect.objectContaining({ identifier: "PAP-100", summary: "First child finished." }),
            ]),
          }),
        }),
      );
    });
  });

  function issueRecord(overrides: Record<string, unknown> = {}) {
    return {
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Issue",
      description: null,
      status: "todo",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      blockedTransitionAt: null,
      labels: [],
      labelIds: [],
      ...overrides,
    };
  }

  it("wakes a Release-like dependent after a terminal reset using the current blocked cycle", async () => {
    const reviewIssueId = "11111111-1111-4111-8111-111111111111";
    const releaseIssueId = "22222222-2222-4222-8222-222222222222";
    const releaseBlockedAt = new Date("2026-08-01T15:00:00.000Z");
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "in_progress",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "done",
    }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: releaseIssueId,
        assigneeAgentId: "agent-release",
        blockerIssueIds: [reviewIssueId],
        blockedTransitionAt: releaseBlockedAt,
      },
    ]);

    const res = await request(await createApp()).patch(`/api/issues/${reviewIssueId}`).send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockFindExistingIssueBlockersResolvedWakeForReadyState).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId: "company-1",
          dependentIssueId: releaseIssueId,
          blockerIssueIds: [reviewIssueId],
          blockedTransitionAt: releaseBlockedAt,
        }),
      );
      expect(mockWakeup).toHaveBeenCalledTimes(1);
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-release",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
            dependentIssueId: releaseIssueId,
            blockerIssueIds: [reviewIssueId],
            blockedTransitionAt: releaseBlockedAt,
          }),
          payload: expect.objectContaining({
            issueId: releaseIssueId,
            resolvedBlockerIssueId: reviewIssueId,
            mutation: "blocker_done",
          }),
        }),
      );
    });
  });

  it("does not enqueue a second wake when the blocker is already done", async () => {
    const reviewIssueId = "11111111-1111-4111-8111-111111111111";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "done",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "done",
    }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "22222222-2222-4222-8222-222222222222",
        assigneeAgentId: "agent-release",
        blockerIssueIds: [reviewIssueId],
        blockedTransitionAt: new Date("2026-08-01T15:00:00.000Z"),
      },
    ]);

    const res = await request(await createApp()).patch(`/api/issues/${reviewIssueId}`).send({ status: "done" });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockWakeup).not.toHaveBeenCalled();
    expect(mockIssueService.listWakeableBlockedDependents).not.toHaveBeenCalled();
  });

  it("wakes a QA-like chain one dependent at a time after each blocker completes", async () => {
    const reviewIssueId = "11111111-1111-4111-8111-111111111111";
    const releaseIssueId = "22222222-2222-4222-8222-222222222222";
    const qaIssueId = "33333333-3333-4333-8333-333333333333";
    const releaseBlockedAt = new Date("2026-08-02T10:00:00.000Z");
    const qaBlockedAt = new Date("2026-08-02T10:05:00.000Z");
    const app = await createApp();

    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "in_progress",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "done",
    }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: releaseIssueId,
        assigneeAgentId: "agent-release",
        blockerIssueIds: [reviewIssueId],
        blockedTransitionAt: releaseBlockedAt,
      },
    ]);

    expect((await request(app).patch(`/api/issues/${reviewIssueId}`).send({ status: "done" })).status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledTimes(1);
    });
    expect(mockWakeup).toHaveBeenCalledWith(
      "agent-release",
      expect.objectContaining({
        payload: expect.objectContaining({ issueId: releaseIssueId }),
        idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: releaseIssueId,
          blockerIssueIds: [reviewIssueId],
          blockedTransitionAt: releaseBlockedAt,
        }),
      }),
    );

    mockWakeup.mockClear();
    mockFindExistingIssueBlockersResolvedWakeForReadyState.mockClear();
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: releaseIssueId,
      identifier: "PAP-RELEASE",
      title: "Release",
      status: "blocked",
      assigneeAgentId: "agent-release",
      blockedTransitionAt: releaseBlockedAt,
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: releaseIssueId,
      identifier: "PAP-RELEASE",
      title: "Release",
      status: "done",
      assigneeAgentId: "agent-release",
    }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: qaIssueId,
        assigneeAgentId: "agent-qa",
        blockerIssueIds: [releaseIssueId],
        blockedTransitionAt: qaBlockedAt,
      },
    ]);

    expect((await request(app).patch(`/api/issues/${releaseIssueId}`).send({ status: "done" })).status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledTimes(1);
    });
    expect(mockWakeup).toHaveBeenCalledWith(
      "agent-qa",
      expect.objectContaining({
        payload: expect.objectContaining({
          issueId: qaIssueId,
          resolvedBlockerIssueId: releaseIssueId,
        }),
        idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: qaIssueId,
          blockerIssueIds: [releaseIssueId],
          blockedTransitionAt: qaBlockedAt,
        }),
      }),
    );
    expect(mockWakeup).not.toHaveBeenCalledWith("agent-release", expect.anything());
  });

  it("restores a blocked-and-ready dependent under the new blocked cycle key", async () => {
    const parentIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const blockedTransitionAt = new Date("2026-08-03T18:00:00.000Z");
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: parentIssueId,
      identifier: "PAP-200",
      title: "Blocked after completion",
      status: "done",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: parentIssueId,
      identifier: "PAP-200",
      title: "Blocked after completion",
      status: "blocked",
      assigneeAgentId: "agent-2",
      blockedTransitionAt,
    }));
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: parentIssueId,
      blockerIssueIds: [childIssueId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${parentIssueId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: [childIssueId],
        unblockDescriptor: { owner: "board", action: "Review the restored dependency" },
      });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockFindExistingIssueBlockersResolvedWakeForReadyState).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          dependentIssueId: parentIssueId,
          blockerIssueIds: [childIssueId],
          blockedTransitionAt,
        }),
      );
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
            dependentIssueId: parentIssueId,
            blockerIssueIds: [childIssueId],
            blockedTransitionAt,
          }),
          payload: expect.objectContaining({
            mutation: "blocked_dependency_restored",
          }),
        }),
      );
    });
  });

  it("does not emit a dependency wake when an unresolved or cancelled blocker remains", async () => {
    mockIssueService.getById.mockResolvedValue(issueRecord({ status: "in_progress" }));
    mockIssueService.update.mockResolvedValue(issueRecord({ status: "done" }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  const assigneeId = "11111111-1111-4111-8111-111111111111";
  const otherAgentId = "22222222-2222-4222-8222-222222222222";
  const replayIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const replayBlockerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const otherBlockerId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  function readyBlockers(issueId: string, blockerIds: string[]) {
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId,
      blockerIssueIds: blockerIds,
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
  }

  function blockersResolvedWakes() {
    return mockWakeup.mock.calls.filter(
      (call) => call[1]?.reason === "issue_blockers_resolved",
    );
  }

  // Entering blocked with every blocker already done still needs a descriptor
  // or a pending card. The descriptor is not a blocker-set change.
  function unblockDescriptorFor(agentId: string) {
    return { owner: { agentId }, action: "Wait for the merge card" };
  }

  function rowsForAgentRun(agentId: string, issueId: string) {
    return (name: string) => {
      if (name === "heartbeat_runs") {
        return [{
          id: "44444444-4444-4444-8444-444444444444",
          companyId: "company-1",
          agentId,
          contextSnapshot: { issueId },
        }];
      }
      if (name === "agents") {
        return [{ id: agentId, companyId: "company-1" }];
      }
      return null;
    };
  }

  it("gives 0 blockers-resolved wakes across five MAG-1009 checkout and self-block laps", async () => {
    readyBlockers(replayIssueId, [replayBlockerId]);
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: replayBlockerId }],
      blocks: [],
    });
    mockIssueService.checkout.mockImplementation(async () =>
      issueRecord({
        id: replayIssueId,
        identifier: "MAG-1009",
        status: "in_progress",
        assigneeAgentId: assigneeId,
        checkoutRunId: "44444444-4444-4444-8444-444444444444",
      }),
    );
    const app = await createApp({
      actor: agentActor(assigneeId),
      rowsForTable: rowsForAgentRun(assigneeId, replayIssueId),
    });

    for (let lap = 0; lap < 5; lap += 1) {
      mockIssueService.getById.mockResolvedValue(issueRecord({
        id: replayIssueId,
        identifier: "MAG-1009",
        status: "blocked",
        assigneeAgentId: assigneeId,
        blockedTransitionAt: new Date(Date.UTC(2026, 10, 5, 15, lap, 0)),
      }));
      const checkout = await request(app)
        .post(`/api/issues/${replayIssueId}/checkout`)
        .send({ agentId: assigneeId, expectedStatuses: ["blocked", "todo", "in_progress"] });
      expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);

      mockIssueService.getById.mockResolvedValue(issueRecord({
        id: replayIssueId,
        identifier: "MAG-1009",
        status: "in_progress",
        assigneeAgentId: assigneeId,
        checkoutRunId: "44444444-4444-4444-8444-444444444444",
        blockedTransitionAt: null,
      }));
      mockIssueService.update.mockResolvedValue(issueRecord({
        id: replayIssueId,
        identifier: "MAG-1009",
        status: "blocked",
        assigneeAgentId: assigneeId,
        blockedTransitionAt: new Date(Date.UTC(2026, 10, 5, 15, 12 + lap, 0)),
      }));
      const patched = await request(app).patch(`/api/issues/${replayIssueId}`).send({
        status: "blocked",
        comment: "still blocked",
        unblockDescriptor: unblockDescriptorFor(assigneeId),
      });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(blockersResolvedWakes()).toEqual([]);
  });

  it("wakes once when the board re-blocks an issue whose blockers are already done", async () => {
    readyBlockers(replayIssueId, [replayBlockerId]);
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: replayIssueId,
      status: "in_progress",
      assigneeAgentId: assigneeId,
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: replayIssueId,
      status: "blocked",
      assigneeAgentId: assigneeId,
      blockedTransitionAt: new Date("2026-11-05T16:00:00.000Z"),
    }));

    const res = await request(await createApp())
      .patch(`/api/issues/${replayIssueId}`)
      .send({
        status: "blocked",
        unblockDescriptor: { owner: "board", action: "Re-block after board review" },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await vi.waitFor(() => {
      expect(blockersResolvedWakes()).toHaveLength(1);
    });
  });

  it("wakes once when the assignee changes the blocker set", async () => {
    readyBlockers(replayIssueId, [otherBlockerId]);
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: replayBlockerId }],
      blocks: [],
    });
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: replayIssueId,
      status: "in_progress",
      assigneeAgentId: assigneeId,
      checkoutRunId: "44444444-4444-4444-8444-444444444444",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: replayIssueId,
      status: "blocked",
      assigneeAgentId: assigneeId,
      blockedTransitionAt: new Date("2026-11-05T16:05:00.000Z"),
    }));

    const res = await request(await createApp({
      actor: agentActor(assigneeId),
      rowsForTable: rowsForAgentRun(assigneeId, replayIssueId),
    }))
      .patch(`/api/issues/${replayIssueId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: [otherBlockerId],
        unblockDescriptor: unblockDescriptorFor(assigneeId),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await vi.waitFor(() => {
      expect(blockersResolvedWakes()).toHaveLength(1);
    });
  });

  it("does not wake when the assignee re-sends the same blocker set", async () => {
    readyBlockers(replayIssueId, [replayBlockerId]);
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: replayBlockerId }],
      blocks: [],
    });
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: replayIssueId,
      status: "in_progress",
      assigneeAgentId: assigneeId,
      checkoutRunId: "44444444-4444-4444-8444-444444444444",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: replayIssueId,
      status: "blocked",
      assigneeAgentId: assigneeId,
      blockedTransitionAt: new Date("2026-11-05T16:06:00.000Z"),
    }));

    const res = await request(await createApp({
      actor: agentActor(assigneeId),
      rowsForTable: rowsForAgentRun(assigneeId, replayIssueId),
    }))
      .patch(`/api/issues/${replayIssueId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: [replayBlockerId],
        unblockDescriptor: unblockDescriptorFor(assigneeId),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(blockersResolvedWakes()).toEqual([]);
  });

  it("wakes once when another agent re-blocks", async () => {
    readyBlockers(replayIssueId, [replayBlockerId]);
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: replayIssueId,
      status: "todo",
      assigneeAgentId: assigneeId,
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: replayIssueId,
      status: "blocked",
      assigneeAgentId: assigneeId,
      blockedTransitionAt: new Date("2026-11-05T16:07:00.000Z"),
    }));

    const res = await request(await createApp({
      actor: agentActor(otherAgentId),
      rowsForTable: rowsForAgentRun(otherAgentId, replayIssueId),
    }))
      .patch(`/api/issues/${replayIssueId}`)
      .send({
        status: "blocked",
        unblockDescriptor: unblockDescriptorFor(otherAgentId),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await vi.waitFor(() => {
      expect(blockersResolvedWakes()).toHaveLength(1);
    });
  });

  it("suppresses a blocker-done wake while a human_only card is pending", async () => {
    mockIssueService.getById.mockResolvedValue(issueRecord({ status: "in_progress" }));
    mockIssueService.update.mockResolvedValue(issueRecord({ status: "done" }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: ["issue-1"],
        blockedTransitionAt: new Date("2026-11-05T16:08:00.000Z"),
      },
    ]);

    const res = await request(await createApp({
      rowsForTable: (name) => (name === "issue_thread_interactions" ? [{ id: "card-1" }] : null),
    })).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(blockersResolvedWakes()).toEqual([]);
  });

  it("suppresses a blocker-done wake while a linked approval is pending", async () => {
    mockIssueService.getById.mockResolvedValue(issueRecord({ status: "in_progress" }));
    mockIssueService.update.mockResolvedValue(issueRecord({ status: "done" }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: ["issue-1"],
        blockedTransitionAt: new Date("2026-11-05T16:09:00.000Z"),
      },
    ]);

    const res = await request(await createApp({
      rowsForTable: (name) => (name === "issue_approvals" ? [{ id: "approval-1" }] : null),
    })).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(blockersResolvedWakes()).toEqual([]);
  });

  it("holds the blockers-resolved cap at 3 wakes in the rolling hour", async () => {
    const recent = new Date();
    mockIssueService.getById.mockResolvedValue(issueRecord({ status: "in_progress" }));
    mockIssueService.update.mockResolvedValue(issueRecord({ status: "done" }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: ["issue-1"],
        blockedTransitionAt: new Date("2026-11-05T16:10:00.000Z"),
      },
    ]);
    const priorWakes = [0, 1, 2].map((index) => ({
      status: "completed",
      requestedAt: recent,
      payload: {
        issueId: "issue-2",
        blockerIssueIds: [`prior-${index}`],
      },
    }));

    const res = await request(await createApp({
      rowsForTable: (name) => (name === "agent_wakeup_requests" ? priorWakes : null),
    })).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await vi.waitFor(() => {
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: ISSUE_BLOCKERS_RESOLVED_WAKE_SUPPRESSED_ACTION,
          entityId: "issue-2",
          details: expect.objectContaining({ reason: "hourly_cap", count: 3 }),
        }),
      );
    });
    expect(blockersResolvedWakes()).toEqual([]);
  });
});
