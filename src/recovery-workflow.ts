import { fail } from "./errors";
import { GitRepository } from "./git";
import { OperationReceipt, recordOperationRecovery } from "./operations";
import { withRepositoryCommandLock } from "./repository-safety";

export async function recoverIncompleteOperation(repo: GitRepository, operationId: string): Promise<OperationReceipt> {
  return withRepositoryCommandLock(repo, "Recover Incomplete Operation", async () => {
    await repo.assertSingleWorktree();
    if (await repo.operationInProgress()) {
      return fail("GIT_OPERATION_IN_PROGRESS", "Finish or abort the active Git operation before recovery. For a WipStream merge, use Continue Pending Merge or Abort Pending Merge.");
    }
    if (await repo.hasConflicts()) {
      return fail("UNRESOLVED_CONFLICTS", "Resolve and stage the remaining conflicted files before recovery.");
    }
    const branch = await repo.currentBranch();
    const head = await repo.hash("HEAD");
    // Explicit recovery preserves all work, including staged and untracked files.
    // It never replays the old plan, moves refs, or claims publication succeeded.
    return recordOperationRecovery(repo, operationId, { resolution: "kept-current-state", branch, head });
  });
}
