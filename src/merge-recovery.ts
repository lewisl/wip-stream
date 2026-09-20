import { GitRepository } from "./git";
import { fail } from "./errors";
import { OperationReceipt, PendingMerge, recordOperationRecovery } from "./operations";

export async function requireRecordedMerge(repo: GitRepository, pending: PendingMerge): Promise<void> {
  const branch = await repo.currentBranch();
  const target = pending.mergeTargetCommit ?? (await repo.refExists(pending.mergeTarget)
    ? await repo.hash(pending.mergeTarget) : undefined);
  if (branch !== pending.branch || !(await repo.refExists("MERGE_HEAD"))
    || await repo.hash("HEAD") !== pending.preHead || !target
    || await repo.hash("MERGE_HEAD") !== target) {
    fail("MERGE_STATE_MISMATCH", "The active Git operation does not match the recorded WipStream merge. Finish or abort that operation in your Git client, then run Recover Incomplete Operation.");
  }
}

/** Read-only inspection. Never infer completion from a clean working directory. */
export async function inspectExternalMergeResolution(
  repo: GitRepository,
  receipt: OperationReceipt
): Promise<OperationReceipt["recovery"]> {
  const pending = receipt.pendingMerge;
  if (!pending || (receipt.status !== "in-progress" && receipt.status !== "planned")) return undefined;
  if (await repo.operationInProgress() || await repo.hasConflicts()) return undefined;
  const branch = await repo.currentBranch();
  if (branch !== pending.branch) return undefined;
  const head = await repo.hash(repo.localRef(branch));

  if (head === pending.preHead) {
    // Older receipts do not snapshot dirty working-file contents. Only a clean
    // starting worktree can be verified as restored from these recorded fields.
    if (pending.preStatus.trim()) return undefined;
    // write-tree can update the index cache. Inspect its contents with diff instead.
    const unchangedIndex = await repo.tryRun(["diff", "--cached", "--quiet", pending.preIndexTree, "--"]);
    if (unchangedIndex.exitCode === 0 && await repo.statusPorcelain() === pending.preStatus) {
      return { resolution: "merge-aborted-externally", branch, head };
    }
    return undefined;
  }

  if (!(await repo.isAncestor(pending.preHead, head))) return undefined;
  const history = await repo.run(["log", "--first-parent", "--format=%H %P", `${pending.preHead}..${head}`, "--"]);
  for (const line of history.split("\n")) {
    const [mergeCommit, firstParent, secondParent, extraParent] = line.split(" ");
    if (firstParent !== pending.preHead || !secondParent || extraParent) continue;
    if (pending.mergeTargetCommit) {
      if (secondParent !== pending.mergeTargetCommit) continue;
    } else {
      // Legacy receipts recorded a ref name only. Accept an exact second parent,
      // or a merge already incorporated into that target (including a pushed
      // Reconcile merge). Otherwise require explicit Keep Current State recovery.
      if (!(await repo.refExists(pending.mergeTarget))) continue;
      const target = await repo.hash(pending.mergeTarget);
      if (target !== secondParent && !(await repo.isAncestor(mergeCommit, target))) continue;
    }
    return { resolution: "merge-completed-externally", branch, head, mergeCommit };
  }
  return undefined;
}

/** Called only inside a workflow's repository command lock. */
export async function recoverExternalMerge(
  repo: GitRepository,
  receipt: OperationReceipt
): Promise<OperationReceipt | undefined> {
  const resolution = await inspectExternalMergeResolution(repo, receipt);
  if (!resolution) return undefined;
  return recordOperationRecovery(repo, receipt.plan.operationId, resolution);
}
