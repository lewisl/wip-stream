import { GitRefUpdate, GitRemoteRefUpdate, GitRepository } from "./git";
import { fail, WipStreamError } from "./errors";
import { readRepositoryConfiguration } from "./repository-model";
import { withRepositoryCommandLock } from "./repository-safety";
import {
  ConfigurationTransition,
  OperationReceipt,
  applyLocalRefTransaction,
  beginOperation,
  completeOperation,
  createOperationPlan,
  inspectIncompleteOperations,
  listOperationReceipts,
  markOperationUndone,
  withMutationBoundary,
} from "./operations";

const UNDOABLE = new Set([
  "Get from Remote",
  "Initialize Repository",
  "Commit and Save",
  "Finish Branch",
  "Condense Branch",
  "Update from Parent",
]);

export { WipStreamError as UndoWorkflowError };

export interface UndoEligibility {
  readonly eligible: boolean;
  readonly operationId?: string;
  readonly command?: string;
  readonly reason?: string;
}

export interface UndoHooks {
  readonly afterRemotePush?: () => Promise<void>;
}

export interface UndoResult {
  readonly operationId: string;
  readonly undoneOperationId: string;
  readonly command: string;
  readonly restoredCheckout?: string;
  readonly restoredCheckpoint: boolean;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => right[index] === value);
}

function refSnapshotsEqual(
  left: readonly { readonly ref: string; readonly objectId: string }[],
  right: readonly { readonly ref: string; readonly objectId: string }[]
): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry.ref === right[index].ref && entry.objectId === right[index].objectId);
}

async function latestTerminalReceipt(repo: GitRepository): Promise<OperationReceipt | undefined> {
  return (await listOperationReceipts(repo))
    .filter((receipt) => receipt.status === "completed" || receipt.status === "undone")
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)))[0];
}

function afterLocalUpdates(receipt: OperationReceipt): readonly GitRefUpdate[] {
  const updates = [
    ...receipt.plan.localRefUpdates,
    ...(receipt.outcome?.additionalLocalRefUpdates ?? []),
    ...(receipt.plan.checkpoint ? [{
      ref: `refs/heads/${receipt.plan.checkpoint.branch}`,
      expectedOld: receipt.plan.checkpoint.before,
      proposed: receipt.plan.checkpoint.after,
    }] : []),
  ];
  const byRef = new Map<string, GitRefUpdate>();
  for (const update of updates) {
    const existing = byRef.get(update.ref);
    if (existing && (existing.expectedOld !== update.expectedOld || existing.proposed !== update.proposed)) {
      return fail("AMBIGUOUS_UNDO_PLAN", `Operation records incompatible updates for ${update.ref}.`);
    }
    byRef.set(update.ref, update);
  }
  return [...byRef.values()];
}

async function refValue(repo: GitRepository, ref: string): Promise<string | null> {
  return (await repo.refExists(ref)) ? await repo.hash(ref) : null;
}

async function localStateMatches(repo: GitRepository, receipt: OperationReceipt): Promise<string | undefined> {
  if ((await repo.statusPorcelain()).trim()) return "The working tree is not clean.";
  if ((await repo.currentBranch()) !== receipt.plan.checkout.after) return "The checkout changed after the operation.";
  const completedLocalRefs = receipt.outcome?.completedLocalRefs;
  if (completedLocalRefs && !refSnapshotsEqual(
    (await repo.listRefs("refs/heads/")).map((ref) => ({ ref: ref.name, objectId: ref.objectId })),
    completedLocalRefs
  )) return "An ordinary local branch changed after the operation.";
  for (const update of afterLocalUpdates(receipt)) {
    if (await refValue(repo, update.ref) !== update.proposed) return `Local ref ${update.ref} changed later.`;
  }
  for (const change of receipt.plan.configurationChanges ?? []) {
    if (!arraysEqual(await repo.getConfigValues(change.key), change.after)) return `Configuration ${change.key} changed later.`;
  }
  return undefined;
}

export async function inspectUndoEligibility(repo: GitRepository): Promise<UndoEligibility> {
  if ((await inspectIncompleteOperations(repo)).length) return { eligible: false, reason: "An operation is incomplete." };
  const receipt = await latestTerminalReceipt(repo);
  if (!receipt) return { eligible: false, reason: "There is no completed operation." };
  if (receipt.status === "undone" || !UNDOABLE.has(receipt.plan.command)) {
    return { eligible: false, reason: "The latest operation is not undoable." };
  }
  const reason = await localStateMatches(repo, receipt);
  return reason
    ? { eligible: false, operationId: receipt.plan.operationId, command: receipt.plan.command, reason }
    : { eligible: true, operationId: receipt.plan.operationId, command: receipt.plan.command };
}

export async function undoLastAction(repo: GitRepository, hooks: UndoHooks = {}): Promise<UndoResult> {
  return withRepositoryCommandLock(repo, "Undo", () => undoLastActionUnlocked(repo, hooks));
}

async function undoLastActionUnlocked(repo: GitRepository, hooks: UndoHooks): Promise<UndoResult> {
  await repo.assertSingleWorktree();
  if (await repo.operationInProgress() || await repo.hasConflicts()) {
    return fail("GIT_OPERATION_IN_PROGRESS", "Finish the current Git operation before Undo.");
  }
  const eligibility = await inspectUndoEligibility(repo);
  if (!eligibility.eligible || !eligibility.operationId) {
    return fail("UNDO_NOT_ELIGIBLE", eligibility.reason ?? "The latest operation is not undoable.");
  }
  const receipt = (await listOperationReceipts(repo)).find(
    (candidate) => candidate.plan.operationId === eligibility.operationId
  ) as OperationReceipt;
  const configuration = await readRepositoryConfiguration(repo);
  const remote = configuration.kind === "uninitialized" ? "origin" : configuration.remote;
  await repo.requireConfiguredRemote(remote);
  await repo.fetchAllBranches(remote);
  const completedRemoteRefs = receipt.outcome?.completedRemoteRefs?.filter(
    (entry) => entry.ref.startsWith(`refs/remotes/${remote}/`)
  );
  if (completedRemoteRefs && !refSnapshotsEqual(
    (await repo.listRefs(`refs/remotes/${remote}/`))
      .filter((ref) => !ref.name.endsWith("/HEAD"))
      .map((ref) => ({ ref: ref.name, objectId: ref.objectId })),
    completedRemoteRefs
  )) return fail("REMOTE_CHANGED_AFTER_OPERATION", "An ordinary remote branch changed after the operation.");

  const reverseRemote: GitRemoteRefUpdate[] = receipt.plan.remoteRefUpdates.map((update) => {
    return { ref: update.ref, expected: update.proposed, proposed: update.expected };
  });
  for (const update of reverseRemote) {
    const branch = update.ref.replace(/^refs\/heads\//, "");
    if (await refValue(repo, repo.remoteTrackingRef(remote, branch)) !== update.expected) {
      return fail("REMOTE_CHANGED_AFTER_OPERATION", `Remote ref ${update.ref} changed after the operation.`);
    }
  }
  const reverseLocal = afterLocalUpdates(receipt).map((update) => ({
    ref: update.ref,
    expectedOld: update.proposed,
    proposed: update.expectedOld,
  }));
  const reverseConfiguration: ConfigurationTransition[] = [...(receipt.plan.configurationChanges ?? [])].reverse();
  const undoPlan = createOperationPlan({
    command: `Undo ${receipt.plan.command}`,
    localRefUpdates: reverseLocal,
    remoteRefUpdates: reverseRemote,
    configurationChanges: reverseConfiguration.map((change) => ({
      key: change.key, before: change.after, after: change.before,
    })),
    checkout: { before: receipt.plan.checkout.after, after: receipt.plan.checkout.before },
  });
  await beginOperation(repo, undoPlan);
  if (reverseRemote.length) {
    await withMutationBoundary(repo, undoPlan.operationId, "remote-push", () => repo.pushRefsAtomic(remote, reverseRemote));
    await hooks.afterRemotePush?.();
    await withMutationBoundary(repo, undoPlan.operationId, "remote-fetch", () => repo.fetchAllBranches(remote));
  }
  const currentBranch = await repo.currentBranch();
  if (currentBranch && reverseLocal.some((update) => update.ref === repo.localRef(currentBranch))) {
    await withMutationBoundary(repo, undoPlan.operationId, "checkout", () => repo.detach());
  }
  if (reverseLocal.length) await applyLocalRefTransaction(repo, undoPlan);
  if (receipt.plan.checkout.before) {
    await withMutationBoundary(repo, undoPlan.operationId, "checkout", () => repo.switch(receipt.plan.checkout.before as string));
  }
  if (reverseConfiguration.length) {
    await withMutationBoundary(repo, undoPlan.operationId, "configuration", async () => {
      for (const change of reverseConfiguration) await repo.replaceConfigValues(change.key, change.before);
    });
  }
  if (receipt.plan.checkpoint) {
    await repo.restoreCommitChanges(receipt.plan.checkpoint.before, receipt.plan.checkpoint.after);
  }
  await completeOperation(repo, undoPlan.operationId);
  await markOperationUndone(repo, receipt.plan.operationId);
  return {
    operationId: undoPlan.operationId,
    undoneOperationId: receipt.plan.operationId,
    command: receipt.plan.command,
    restoredCheckout: receipt.plan.checkout.before,
    restoredCheckpoint: Boolean(receipt.plan.checkpoint),
  };
}
