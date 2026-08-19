import { GitError, GitRepository } from "./git";
import { commitAndSave, CommitAndSaveHooks, CommitAndSaveResult } from "./generalized-workflow";
import {
  inspectBranchInventory,
  readRepositoryConfiguration,
  snapshotRemoteTips,
} from "./repository-model";
import { withRepositoryCommandLock } from "./repository-safety";
import {
  OperationReceipt,
  PendingMerge,
  abortOperation,
  beginOperation,
  completeOperation,
  createOperationPlan,
  inspectIncompleteOperations,
  recordOperationPhase,
  recordOperationOutcome,
  recordPendingMerge,
  recoveryRef,
  withMutationBoundary,
} from "./operations";

export class ConflictWorkflowError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConflictWorkflowError";
    this.code = code;
  }
}

export interface PendingMergeStatus {
  readonly operationId: string;
  readonly command: PendingMerge["command"];
  readonly branch: string;
  readonly mergeTarget: string;
  readonly conflicts: readonly string[];
  readonly actions: readonly ["continue", "abort"];
}

export interface ReconcileResult {
  readonly operationId: string;
  readonly branch: string;
  readonly pending: boolean;
  readonly conflicts: readonly string[];
  readonly save?: CommitAndSaveResult;
}

export interface ContinueMergeResult {
  readonly operationId: string;
  readonly command: PendingMerge["command"];
  readonly save: CommitAndSaveResult;
}

export interface AbortMergeResult {
  readonly operationId: string;
  readonly command: PendingMerge["command"];
  readonly restored: true;
}

export interface AbortMergeHooks {
  readonly afterGitAbort?: () => Promise<void>;
}

function fail(code: string, message: string): never {
  throw new ConflictWorkflowError(code, message);
}

function status(receipt: OperationReceipt): PendingMergeStatus {
  const pending = receipt.pendingMerge;
  if (!pending) {
    return fail("INVALID_PENDING_OPERATION", `Operation “${receipt.plan.operationId}” has no pending merge record.`);
  }
  return {
    operationId: receipt.plan.operationId,
    command: pending.command,
    branch: pending.branch,
    mergeTarget: pending.mergeTarget,
    conflicts: pending.conflicts,
    actions: ["continue", "abort"],
  };
}

export async function inspectPendingMerge(repo: GitRepository): Promise<PendingMergeStatus | undefined> {
  const pending = (await inspectIncompleteOperations(repo)).filter((receipt) => receipt.pendingMerge);
  if (pending.length > 1) {
    return fail("MULTIPLE_PENDING_OPERATIONS", "More than one WipStream merge is pending; inspect operation receipts.");
  }
  if (pending.length === 1) {
    return status(pending[0]);
  }
  if (await repo.operationInProgress()) {
    return fail(
      "UNNAMED_GIT_OPERATION",
      "Git reports an operation in progress, but WipStream has no matching pending receipt. Inspect Git state manually."
    );
  }
  return undefined;
}

async function requireReconcileRepository(repo: GitRepository): Promise<{ remote: string; branch: string }> {
  await repo.assertSingleWorktree();
  if (await repo.isBare() || await repo.isShallow()) {
    return fail("UNSUPPORTED_REPOSITORY", "Reconcile requires a complete, non-bare working repository.");
  }
  if (await repo.operationInProgress() || await repo.hasConflicts()) {
    return fail("GIT_OPERATION_IN_PROGRESS", "Resolve or abort the current Git operation before Reconcile.");
  }
  if ((await repo.statusPorcelain()).trim()) {
    return fail("DIRTY_WORKTREE", "Reconcile requires the locally checkpointed branch to have a clean working tree.");
  }
  const incomplete = await inspectIncompleteOperations(repo);
  if (incomplete.length) {
    return fail("INCOMPLETE_WIPSTREAM_OPERATION", `Inspect operation “${incomplete[0].plan.operationId}” first.`);
  }
  const configuration = await readRepositoryConfiguration(repo);
  if (configuration.kind !== "version2") {
    return fail("VERSION_2_REQUIRED", "Initialize or migrate this repository before Reconcile.");
  }
  const branch = await repo.currentBranch();
  if (!branch) {
    return fail("DETACHED_HEAD", "Check out the divergent branch before Reconcile.");
  }
  return { remote: configuration.remote, branch };
}

export async function reconcileWithRemote(
  repo: GitRepository,
  saveHooks: CommitAndSaveHooks = {}
): Promise<ReconcileResult> {
  const merge = await withRepositoryCommandLock(
    repo,
    "Reconcile with Remote",
    () => reconcileWithRemoteUnlocked(repo)
  );
  if (merge.pending) {
    return merge;
  }
  const save = await commitAndSave(repo, saveHooks);
  return { ...merge, save };
}

async function reconcileWithRemoteUnlocked(repo: GitRepository): Promise<ReconcileResult> {
  const { remote, branch } = await requireReconcileRepository(repo);
  const previous = await snapshotRemoteTips(repo, remote);
  await repo.fetchAllBranches(remote);
  const inventory = await inspectBranchInventory(repo, remote, previous);
  const current = inventory.find((candidate) => candidate.name === branch);
  if (current?.relation !== "diverged" || !current.fetchedRemoteTip) {
    return fail(
      "CURRENT_BRANCH_NOT_DIVERGED",
      `Reconcile is available only when checked-out branch “${branch}” has diverged from its fetched remote counterpart.`
    );
  }
  const otherUnsafe = inventory.filter(
    (candidate) => candidate.name !== branch && candidate.relation === "diverged"
  );
  if (otherUnsafe.length) {
    return fail(
      "OTHER_DIVERGENCE",
      `Reconcile “${branch}” only after resolving other divergent branches: ${otherUnsafe.map(({ name }) => name).join(", ")}.`
    );
  }

  const before = await repo.hash(repo.localRef(branch));
  const preIndexTree = await repo.indexTree();
  const preStatus = await repo.statusPorcelain();
  const mergeTarget = repo.remoteRef(remote, branch);
  const plan = createOperationPlan({
    command: "Reconcile with Remote",
    checkout: { before: branch, after: branch },
    destructiveEffects: [{
      kind: "rewrite-local-ref",
      ref: repo.localRef(branch),
      description: `Merge fetched ${remote}/${branch} into ${branch}`,
    }],
  });
  await beginOperation(repo, plan);
  await withMutationBoundary(repo, plan.operationId, "local-refs", () => repo.updateRefs([{
    ref: recoveryRef(plan.operationId, 0),
    expectedOld: null,
    proposed: before,
  }]));
  try {
    await withMutationBoundary(repo, plan.operationId, "merge", () => repo.merge(mergeTarget));
  } catch (error) {
    const conflicts = await repo.conflictPaths();
    if (error instanceof GitError && await repo.operationInProgress()) {
      await recordPendingMerge(repo, plan.operationId, {
        kind: "merge",
        command: "Reconcile with Remote",
        branch,
        mergeTarget,
        preHead: before,
        preIndexTree,
        preStatus,
        conflicts,
      });
      return { operationId: plan.operationId, branch, pending: true, conflicts };
    }
    throw error;
  }
  await recordOperationOutcome(repo, plan.operationId, {
    additionalLocalRefUpdates: [{
      ref: repo.localRef(branch),
      expectedOld: before,
      proposed: await repo.hash(repo.localRef(branch)),
    }],
  });
  await completeOperation(repo, plan.operationId);
  return { operationId: plan.operationId, branch, pending: false, conflicts: [] };
}

async function pendingReceipt(repo: GitRepository): Promise<OperationReceipt> {
  const receipts = (await inspectIncompleteOperations(repo)).filter((receipt) => receipt.pendingMerge);
  if (receipts.length !== 1) {
    return fail(
      receipts.length ? "MULTIPLE_PENDING_OPERATIONS" : "NO_PENDING_MERGE",
      receipts.length ? "More than one WipStream merge is pending." : "No WipStream merge is pending."
    );
  }
  return receipts[0];
}

export async function continuePendingMerge(
  repo: GitRepository,
  saveHooks: CommitAndSaveHooks = {}
): Promise<ContinueMergeResult> {
  const completed = await withRepositoryCommandLock(
    repo,
    "Continue",
    () => continuePendingMergeUnlocked(repo)
  );
  const save = await commitAndSave(repo, saveHooks);
  return { ...completed, save };
}

async function continuePendingMergeUnlocked(
  repo: GitRepository
): Promise<Omit<ContinueMergeResult, "save">> {
  await repo.assertSingleWorktree();
  const receipt = await pendingReceipt(repo);
  const pending = receipt.pendingMerge as PendingMerge;
  const conflicts = await repo.conflictPaths();
  if (conflicts.length) {
    return fail("UNRESOLVED_CONFLICTS", `Resolve these files before Continue: ${conflicts.join(", ")}.`);
  }
  if (!(await repo.operationInProgress())) {
    return fail("MERGE_STATE_MISSING", "Git no longer reports the recorded merge; Abort or inspect recovery state.");
  }
  if ((await repo.currentBranch()) !== pending.branch) {
    return fail("CHECKOUT_CHANGED", `Pending merge belongs to branch “${pending.branch}”.`);
  }
  await repo.stageAll();
  await repo.commitMerge();
  await recordOperationPhase(repo, receipt.plan.operationId, "after-merge");
  await recordOperationOutcome(repo, receipt.plan.operationId, {
    additionalLocalRefUpdates: [{
      ref: repo.localRef(pending.branch),
      expectedOld: pending.preHead,
      proposed: await repo.hash(repo.localRef(pending.branch)),
    }],
  });
  await completeOperation(repo, receipt.plan.operationId);
  return { operationId: receipt.plan.operationId, command: pending.command };
}

export async function abortPendingMerge(
  repo: GitRepository,
  hooks: AbortMergeHooks = {}
): Promise<AbortMergeResult> {
  return withRepositoryCommandLock(repo, "Abort", () => abortPendingMergeUnlocked(repo, hooks));
}

async function abortPendingMergeUnlocked(
  repo: GitRepository,
  hooks: AbortMergeHooks
): Promise<AbortMergeResult> {
  await repo.assertSingleWorktree();
  const receipt = await pendingReceipt(repo);
  const pending = receipt.pendingMerge as PendingMerge;
  if (!(await repo.operationInProgress())) {
    return fail("MERGE_STATE_MISSING", "Git no longer reports the recorded merge; the receipt was retained.");
  }
  await repo.abortMerge();
  await hooks.afterGitAbort?.();
  const actualBranch = await repo.currentBranch();
  const actualHead = actualBranch ? await repo.hash(repo.localRef(actualBranch)) : undefined;
  const actualStatus = await repo.statusPorcelain();
  const actualIndexTree = await repo.indexTree();
  if (
    actualBranch !== pending.branch
    || actualHead !== pending.preHead
    || actualStatus !== pending.preStatus
    || actualIndexTree !== pending.preIndexTree
    || await repo.operationInProgress()
  ) {
    return fail(
      "ABORT_VERIFICATION_FAILED",
      `Git merge --abort did not restore the recorded state for “${pending.branch}”. Operation “${receipt.plan.operationId}” remains pending.`
    );
  }
  await abortOperation(repo, receipt.plan.operationId);
  return { operationId: receipt.plan.operationId, command: pending.command, restored: true };
}
