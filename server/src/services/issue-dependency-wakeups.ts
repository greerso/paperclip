import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  approvals,
  issueApprovals,
  issueThreadInteractions,
} from "@paperclipai/db";

export const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";
export const ISSUE_BLOCKERS_RESOLVED_WAKE_SUPPRESSED_ACTION =
  "issue.blockers_resolved_wake_suppressed";

/** At most this many blockers-resolved wakes for one dependent in a rolling hour. */
export const ISSUE_BLOCKERS_RESOLVED_WAKE_HOURLY_CAP = 3;

/** A completed same-set wake inside this window covers a later blockers_restored emit. */
export const ISSUE_BLOCKERS_RESOLVED_RESTORED_DEDUP_MS = 24 * 60 * 60 * 1000;

const ISSUE_BLOCKERS_RESOLVED_WAKE_HOUR_MS = 60 * 60 * 1000;

// These rows were not delivered wakes. They must not spend the hourly cap.
const NON_COUNTING_WAKE_STATUSES = new Set(["skipped", "failed", "cancelled"]);

// A wake counts as "already delivered or in flight for the current ready state"
// for these statuses. The level-triggered state key uses this full set so that
// one wake for a ready state suppresses further wakes for the SAME state. This
// bounds reconciliation: after one wake, later passes find the completed row.
const IDEMPOTENT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "completed",
] as const;

// A wake counts as "still in flight" for these statuses. The `completed` status
// is not in this set on purpose. Dependency readiness is level-triggered, so a
// historical completed per-edge wake must never suppress a new wake for the
// current ready state. The dedup uses this set only for the legacy per-edge key
// and for old no-cycle state keys that are still queued after a deploy.
const IN_FLIGHT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
] as const;

const IDEMPOTENT_DEPENDENCY_WAKE_STATUS_SET = new Set<string>(IDEMPOTENT_DEPENDENCY_WAKE_STATUSES);
const IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET = new Set<string>(IN_FLIGHT_DEPENDENCY_WAKE_STATUSES);

export type IssueBlockersResolvedWakeCycleInput = Date | string | null | undefined;

export type IssueBlockersResolvedReadyStateInput = {
  dependentIssueId: string;
  blockerIssueIds: string[];
  blockedTransitionAt?: IssueBlockersResolvedWakeCycleInput;
};

/**
 * Canonical blocked-cycle stamp for the dependency-ready state key.
 * `blockedTransitionAt` is UTC ISO-8601, or `none` when the dependent has no
 * recorded transition into `blocked`.
 */
export function formatIssueBlockersResolvedWakeCycle(
  blockedTransitionAt: IssueBlockersResolvedWakeCycleInput,
): string {
  if (blockedTransitionAt == null || blockedTransitionAt === "") return "none";
  const parsed = blockedTransitionAt instanceof Date
    ? blockedTransitionAt
    : new Date(blockedTransitionAt);
  if (Number.isNaN(parsed.getTime())) return "none";
  return parsed.toISOString();
}

function uniqueSortedBlockerIssueIds(blockerIssueIds: readonly string[]): string[] {
  return [...new Set(blockerIssueIds.filter(Boolean))].sort();
}

export function sameBlockerIssueIdSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const a = uniqueSortedBlockerIssueIds(left);
  const b = uniqueSortedBlockerIssueIds(right);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Whether a transition into `blocked` should wake the assignee because every
 * recorded blocker is already done.
 *
 * The assignee re-blocking itself, without a new blocker set, is a wait on
 * something outside the blocker graph. Waking it stamps a new
 * `blockedTransitionAt`, so the cycle key never matches and the agent is
 * checked out again. Board or other-agent re-blocks, reassignment, and a real
 * blocker-set change still wake.
 */
export function shouldWakeOnRestoredBlockedDependency(input: {
  previousStatus: string;
  nextStatus: string;
  previousAssigneeAgentId: string | null;
  nextAssigneeAgentId: string | null;
  /** Undefined when the PATCH body omitted `blockedByIssueIds`. */
  blockedByIssueIds: readonly string[] | undefined;
  existingBlockerIssueIds: readonly string[];
  actorType: string;
  actorAgentId: string | null;
}): boolean {
  if (input.nextStatus !== "blocked" || !input.nextAssigneeAgentId) return false;
  const assigneeChanged = input.previousAssigneeAgentId !== input.nextAssigneeAgentId;
  const blockerFieldPresent = input.blockedByIssueIds !== undefined;
  if (input.previousStatus === "blocked" && !blockerFieldPresent && !assigneeChanged) {
    return false;
  }
  const blockerSetUnchanged =
    !blockerFieldPresent ||
    sameBlockerIssueIdSet(input.blockedByIssueIds ?? [], input.existingBlockerIssueIds);
  const assigneeSelfUnchanged =
    input.actorType === "agent" &&
    input.actorAgentId !== null &&
    input.actorAgentId === input.nextAssigneeAgentId &&
    !assigneeChanged &&
    blockerSetUnchanged;
  return !assigneeSelfUnchanged;
}

export type IssueBlockersResolvedWakeSuppressionReason =
  | "recent_same_set"
  | "human_gate"
  | "hourly_cap";

export type IssueBlockersResolvedWakeSuppression = {
  reason: IssueBlockersResolvedWakeSuppressionReason;
  count?: number;
};

type BlockersResolvedWakeHistoryRow = {
  status: string;
  requestedAt: Date;
  payload: unknown;
};

function wakePayloadIssueId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const issueId = (payload as { issueId?: unknown }).issueId;
  return typeof issueId === "string" ? issueId : null;
}

function wakePayloadBlockerIds(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object") return null;
  const ids = (payload as { blockerIssueIds?: unknown }).blockerIssueIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return null;
  return ids;
}

/**
 * Extra gates shared by every blockers-resolved emit path.
 *
 * - `issue.blockers_restored`: a completed wake for the same dependent and the
 *   same sorted blocker set in the last 24h covers, whatever `blockedTransitionAt`.
 * - A pending `human_only` interaction or a pending linked approval skips the
 *   wake. The interaction or approval resolution wake takes over.
 * - More than the hourly cap suppresses. Callers log that case.
 */
export function suppressionForBlockersResolvedWakeHistory(input: {
  source: string;
  dependentIssueId: string;
  blockerIssueIds: readonly string[];
  now: Date;
  wakes: BlockersResolvedWakeHistoryRow[];
  pendingHumanOnlyInteraction: boolean;
  pendingLinkedApproval: boolean;
}): IssueBlockersResolvedWakeSuppression | null {
  if (input.pendingHumanOnlyInteraction || input.pendingLinkedApproval) {
    return { reason: "human_gate" };
  }

  const forDependent = input.wakes.filter(
    (wake) => wakePayloadIssueId(wake.payload) === input.dependentIssueId,
  );

  if (input.source === "issue.blockers_restored") {
    const since = input.now.getTime() - ISSUE_BLOCKERS_RESOLVED_RESTORED_DEDUP_MS;
    const covered = forDependent.some((wake) => {
      if (wake.status !== "completed") return false;
      if (wake.requestedAt.getTime() < since) return false;
      const ids = wakePayloadBlockerIds(wake.payload);
      return ids !== null && sameBlockerIssueIdSet(ids, input.blockerIssueIds);
    });
    if (covered) return { reason: "recent_same_set" };
  }

  const hourStart = input.now.getTime() - ISSUE_BLOCKERS_RESOLVED_WAKE_HOUR_MS;
  const count = forDependent.filter((wake) => {
    if (NON_COUNTING_WAKE_STATUSES.has(wake.status)) return false;
    return wake.requestedAt.getTime() >= hourStart;
  }).length;
  if (count >= ISSUE_BLOCKERS_RESOLVED_WAKE_HOURLY_CAP) {
    return { reason: "hourly_cap", count };
  }
  return null;
}

function hashBlockerReadyStateDigest(sortedBlockerIssueIds: string[], cycle: string | null): string {
  const payload = cycle == null
    ? sortedBlockerIssueIds.join(",")
    : `${sortedBlockerIssueIds.join(",")}\n${cycle}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function buildStateKey(dependentIssueId: string, digest: string, blockerCount: number): string {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    "state",
    dependentIssueId,
    String(blockerCount),
    digest,
  ].join(":");
}

/**
 * Legacy per-edge idempotency key. One key encodes a single resolved blocker
 * edge `issue_blockers_resolved:{dependentIssueId}:{resolvedBlockerIssueId}`.
 * The dedup keeps this format only to read wake rows written before the
 * level-triggered state key existed.
 */
export function buildIssueBlockersResolvedWakeIdempotencyKey(input: {
  dependentIssueId: string;
  resolvedBlockerIssueId: string;
}) {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    input.dependentIssueId,
    input.resolvedBlockerIssueId,
  ].join(":");
}

/**
 * Pre-cycle level-triggered key. Rows written before the ready state included
 * `blockedTransitionAt` hashed only the sorted blocker ids. Lookup still reads
 * this format so an in-flight deploy-overlap wake can suppress a duplicate.
 */
export function buildIssueBlockersResolvedWakeStateKeyWithoutCycle(input: {
  dependentIssueId: string;
  blockerIssueIds: string[];
}) {
  const sortedBlockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  return buildStateKey(
    input.dependentIssueId,
    hashBlockerReadyStateDigest(sortedBlockerIssueIds, null),
    sortedBlockerIssueIds.length,
  );
}

/**
 * Level-triggered idempotency key. One key encodes the full set of blockers that
 * defines the current dependency-ready state plus the dependent's current
 * blocked cycle (`blockedTransitionAt`, or `none`). Two wakes for the same ready
 * state share the key. A wake from an earlier blocked cycle has a different
 * cycle stamp, so it produces a different key and never suppresses the current
 * wake. All three emit paths (route-time, finalize-time, periodic backstop) use
 * this key so they share one idempotency rule.
 */
export function buildIssueBlockersResolvedWakeStateKey(input: IssueBlockersResolvedReadyStateInput) {
  const sortedBlockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  const cycle = formatIssueBlockersResolvedWakeCycle(input.blockedTransitionAt);
  return buildStateKey(
    input.dependentIssueId,
    hashBlockerReadyStateDigest(sortedBlockerIssueIds, cycle),
    sortedBlockerIssueIds.length,
  );
}

function parseWakeCycleDate(blockedTransitionAt: IssueBlockersResolvedWakeCycleInput): Date | null {
  if (blockedTransitionAt == null || blockedTransitionAt === "") return null;
  const parsed = blockedTransitionAt instanceof Date
    ? blockedTransitionAt
    : new Date(blockedTransitionAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function wakeCoversIssueBlockersResolvedReadyState(
  wake: {
    status: string;
    idempotencyKey: string | null;
    requestedAt: Date;
  },
  keys: {
    cycleKey: string;
    oldStateKey: string;
    legacyKeys: Set<string>;
    blockedTransitionAt: Date | null;
  },
): boolean {
  const idempotencyKey = wake.idempotencyKey;
  if (!idempotencyKey) return false;

  if (idempotencyKey === keys.cycleKey) {
    return IDEMPOTENT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status);
  }

  if (idempotencyKey === keys.oldStateKey) {
    if (IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status)) return true;
    if (wake.status !== "completed") return false;
    if (!keys.blockedTransitionAt) return true;
    return wake.requestedAt.getTime() >= keys.blockedTransitionAt.getTime();
  }

  if (keys.legacyKeys.has(idempotencyKey)) {
    return IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status);
  }

  return false;
}

/**
 * Find a wake that already covers the current dependency-ready state of the
 * dependent issue. The check is level-triggered and cycle-aware:
 *
 * - The cycle-aware state key matches a wake in any idempotent status
 *   (including `completed`). This suppresses a duplicate for the SAME ready
 *   state, including the current blocked cycle.
 * - The old no-cycle state key matches in-flight statuses (deploy overlap),
 *   or a `completed` wake whose `requestedAt` is at or after the current
 *   `blockedTransitionAt` (same cycle). A completed old-key wake from a
 *   previous cycle does not suppress.
 * - Each legacy per-edge key matches only a wake that is still in flight.
 *
 * Returns the first matching wake or `null`.
 */
export async function findExistingIssueBlockersResolvedWakeForReadyState(
  db: Db,
  input: {
    companyId: string;
    dependentIssueId: string;
    blockerIssueIds: string[];
    blockedTransitionAt?: IssueBlockersResolvedWakeCycleInput;
  },
) {
  const cycleKey = buildIssueBlockersResolvedWakeStateKey(input);
  const oldStateKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle(input);
  const legacyKeyList = [
    ...new Set(
      input.blockerIssueIds
        .filter(Boolean)
        .map((resolvedBlockerIssueId) =>
          buildIssueBlockersResolvedWakeIdempotencyKey({
            dependentIssueId: input.dependentIssueId,
            resolvedBlockerIssueId,
          }),
        ),
    ),
  ];
  const lookupKeys = [...new Set([cycleKey, oldStateKey, ...legacyKeyList])];
  const blockedTransitionAt = parseWakeCycleDate(input.blockedTransitionAt);

  const rows = await db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      requestedAt: agentWakeupRequests.requestedAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        inArray(agentWakeupRequests.idempotencyKey, lookupKeys),
      ),
    );

  const covering = rows.find((row) =>
    wakeCoversIssueBlockersResolvedReadyState(row, {
      cycleKey,
      oldStateKey,
      legacyKeys: new Set(legacyKeyList),
      blockedTransitionAt,
    }),
  );
  return covering ?? null;
}

export async function findIssueBlockersResolvedWakeSuppression(
  db: Db,
  input: {
    companyId: string;
    dependentIssueId: string;
    blockerIssueIds: string[];
    source: string;
    now?: Date;
  },
): Promise<IssueBlockersResolvedWakeSuppression | null> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - ISSUE_BLOCKERS_RESOLVED_RESTORED_DEDUP_MS);
  const [wakes, humanOnly, pendingApproval] = await Promise.all([
    db
      .select({
        status: agentWakeupRequests.status,
        requestedAt: agentWakeupRequests.requestedAt,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, input.companyId),
          eq(agentWakeupRequests.reason, ISSUE_BLOCKERS_RESOLVED_WAKE_REASON),
          gte(agentWakeupRequests.requestedAt, since),
          sql`${agentWakeupRequests.payload}->>'issueId' = ${input.dependentIssueId}`,
        ),
      ),
    db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, input.companyId),
          eq(issueThreadInteractions.issueId, input.dependentIssueId),
          eq(issueThreadInteractions.status, "pending"),
          eq(issueThreadInteractions.effectiveResolverPolicy, "human_only"),
        ),
      )
      .limit(1),
    db
      .select({ id: approvals.id })
      .from(issueApprovals)
      .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
      .where(
        and(
          eq(issueApprovals.companyId, input.companyId),
          eq(issueApprovals.issueId, input.dependentIssueId),
          eq(approvals.companyId, input.companyId),
          eq(approvals.status, "pending"),
        ),
      )
      .limit(1),
  ]);

  return suppressionForBlockersResolvedWakeHistory({
    source: input.source,
    dependentIssueId: input.dependentIssueId,
    blockerIssueIds: input.blockerIssueIds,
    now,
    wakes,
    pendingHumanOnlyInteraction: humanOnly.length > 0,
    pendingLinkedApproval: pendingApproval.length > 0,
  });
}
