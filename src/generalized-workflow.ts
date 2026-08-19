import { GitRefUpdate, GitRepository } from "./git";
import {
  BranchInventoryEntry,
  getBranchParent,
  inspectBranchInventory,
  readRepositoryConfiguration,
  resolveRemoteDefaultBranch,
  snapshotRemoteTips,
} from "./repository-model";
import { withRepositoryCommandLock } from "./repository-safety";
import {
  applyLocalRefTransaction,
  beginOperation,
  completeOperation,
  createOperationPlan,
  inspectIncompleteOperations,
  withMutationBoundary,
} from "./operations";

export interface UnsafeBranch {
  readonly name: string;
  readonly relation: BranchInventoryEntry["relation"];
  readonly reason: string;
}

export type ParentAdvisoryState = "current" | "probably-integrated" | "parent-advanced" | "parent-missing";

export interface ParentAdvisory {
  readonly branch: string;
  readonly parent: string;
  readonly source: "recorded" | "assumed-default";
  readonly state: ParentAdvisoryState;
}

export interface GetFromRemoteResult {
  readonly operationId: string;
  readonly updated: boolean;
  readonly checkout: string;
  readonly created: readonly string[];
  readonly fastForwarded: readonly string[];
  readonly deleted: readonly string[];
  readonly advisories: readonly ParentAdvisory[];
}

export class GeneralizedWorkflowError extends Error {
  public readonly code: string;
  public readonly unsafeBranches: readonly UnsafeBranch[];

  constructor(code: string, message: string, unsafeBranches: readonly UnsafeBranch[] = []) {
    super(message);
    this.name = "GeneralizedWorkflowError";
    this.code = code;
    this.unsafeBranches = unsafeBranches;
  }
}

function fail(code: string, message: string, unsafeBranches: readonly UnsafeBranch[] = []): never {
  throw new GeneralizedWorkflowError(code, message, unsafeBranches);
}

async function requireStableGetRepository(repo: GitRepository): Promise<void> {
  await repo.assertSingleWorktree();
  if (await repo.isBare()) {
    fail("BARE_REPOSITORY", "Get from Remote requires a normal working repository.");
  }
  if (await repo.isShallow()) {
    fail("SHALLOW_REPOSITORY", "Get from Remote requires complete repository history.");
  }
  if (await repo.operationInProgress()) {
    fail("GIT_OPERATION_IN_PROGRESS", "Finish the active Git operation before Get from Remote.");
  }
  if (await repo.hasConflicts()) {
    fail("UNRESOLVED_CONFLICTS", "Resolve Git conflicts before Get from Remote.");
  }
  if ((await repo.statusPorcelain()).trim()) {
    fail("DIRTY_WORKTREE", "Get from Remote requires a clean working tree.");
  }
  const incomplete = await inspectIncompleteOperations(repo);
  if (incomplete.length) {
    fail(
      "INCOMPLETE_WIPSTREAM_OPERATION",
      `Inspect the incomplete WipStream operation “${incomplete[0].plan.operationId}” before Get from Remote.`
    );
  }
}

function unsafeBranches(inventory: readonly BranchInventoryEntry[]): readonly UnsafeBranch[] {
  const result: UnsafeBranch[] = [];
  for (const branch of inventory) {
    if (["local-ahead", "local-only", "diverged"].includes(branch.relation)) {
      result.push({
        name: branch.name,
        relation: branch.relation,
        reason: branch.relation === "diverged"
          ? "local and remote history diverged"
          : branch.relation === "local-only"
            ? "the branch has no fetched remote counterpart"
            : "the branch contains unpublished local commits",
      });
      continue;
    }
    if (branch.relation === "remotely-deleted" && branch.localTip && branch.localTip !== branch.previousRemoteTip) {
      result.push({
        name: branch.name,
        relation: branch.relation,
        reason: "the branch changed locally after its last observed remote tip",
      });
    }
  }
  return result;
}

function localUpdates(inventory: readonly BranchInventoryEntry[], repo: GitRepository): readonly GitRefUpdate[] {
  return inventory.flatMap((branch) => {
    if (branch.relation === "remote-only") {
      return [{ ref: repo.localRef(branch.name), expectedOld: null, proposed: branch.fetchedRemoteTip ?? null }];
    }
    if (branch.relation === "remote-ahead") {
      return [{ ref: repo.localRef(branch.name), expectedOld: branch.localTip ?? null, proposed: branch.fetchedRemoteTip ?? null }];
    }
    if (branch.relation === "remotely-deleted" && branch.localTip) {
      return [{ ref: repo.localRef(branch.name), expectedOld: branch.localTip, proposed: null }];
    }
    return [];
  });
}

function mapsEqual(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  return left.size === right.size && [...left].every(([name, tip]) => right.get(name) === tip);
}

async function checkoutAfterGet(
  repo: GitRepository,
  currentBranch: string,
  remoteDefaultBranch: string,
  inventory: readonly BranchInventoryEntry[]
): Promise<string> {
  const current = inventory.find((branch) => branch.name === currentBranch);
  const currentWillBeDeleted = current?.relation === "remotely-deleted" && Boolean(current.localTip);
  if (!currentWillBeDeleted) {
    return currentBranch;
  }
  const recordedParent = await getBranchParent(repo, currentBranch);
  if (recordedParent) {
    const parent = inventory.find((branch) => branch.name === recordedParent);
    if (parent?.fetchedRemoteTip) {
      return recordedParent;
    }
  }
  const fallback = inventory.find((branch) => branch.name === remoteDefaultBranch);
  if (!fallback?.fetchedRemoteTip) {
    return fail("NO_SURVIVING_CHECKOUT", "The deleted current branch has no surviving parent or remote default branch.");
  }
  return remoteDefaultBranch;
}

async function verifyBranchParity(repo: GitRepository, remote: string): Promise<void> {
  const currentRemoteTips = await snapshotRemoteTips(repo, remote);
  const inventory = await inspectBranchInventory(repo, remote, currentRemoteTips);
  const mismatches = inventory.filter((branch) => branch.relation !== "equal");
  if (mismatches.length) {
    fail(
      "BRANCH_PARITY_FAILED",
      `Get from Remote did not establish branch parity: ${mismatches.map((branch) => `${branch.name} (${branch.relation})`).join(", ")}.`
    );
  }
}

async function parentAdvisories(
  repo: GitRepository,
  remoteDefaultBranch: string,
  inventory: readonly BranchInventoryEntry[]
): Promise<readonly ParentAdvisory[]> {
  const result: ParentAdvisory[] = [];
  const names = new Set(inventory.filter((branch) => branch.fetchedRemoteTip).map((branch) => branch.name));
  for (const branch of [...names].sort()) {
    if (branch === remoteDefaultBranch) {
      continue;
    }
    const recordedParent = await getBranchParent(repo, branch);
    const parent = recordedParent ?? remoteDefaultBranch;
    let state: ParentAdvisoryState;
    if (!names.has(parent)) {
      state = "parent-missing";
    } else if (await repo.isAncestor(repo.localRef(parent), repo.localRef(branch))) {
      state = "current";
    } else if (await repo.isAncestor(repo.localRef(branch), repo.localRef(parent))) {
      state = "probably-integrated";
    } else {
      state = "parent-advanced";
    }
    result.push({ branch, parent, source: recordedParent ? "recorded" : "assumed-default", state });
  }
  return result;
}

export async function getFromRemote(repo: GitRepository): Promise<GetFromRemoteResult> {
  return withRepositoryCommandLock(repo, "Get from Remote", () => getFromRemoteUnlocked(repo));
}

async function getFromRemoteUnlocked(repo: GitRepository): Promise<GetFromRemoteResult> {
  await requireStableGetRepository(repo);
  const configuration = await readRepositoryConfiguration(repo);
  if (configuration.kind !== "version2") {
    return fail("VERSION_2_REQUIRED", "Initialize or migrate this repository before using generalized Get from Remote.");
  }
  await repo.ensureRemote(configuration.remote);
  const currentBranch = await repo.currentBranch();
  if (!currentBranch) {
    return fail("DETACHED_HEAD", "Check out an ordinary branch before Get from Remote.");
  }

  const previousRemoteTips = await snapshotRemoteTips(repo, configuration.remote);
  await inspectBranchInventory(repo, configuration.remote, previousRemoteTips);
  await repo.fetchAllBranches(configuration.remote);
  const remoteDefaultBranch = await resolveRemoteDefaultBranch(repo, configuration.remote);
  const fetchedRemoteTips = await snapshotRemoteTips(repo, configuration.remote);
  const inventory = await inspectBranchInventory(repo, configuration.remote, previousRemoteTips);
  const unsafe = unsafeBranches(inventory);
  if (unsafe.length) {
    return fail(
      "GET_UNSAFE_BRANCHES",
      `Get from Remote fetched safely but did not move local branches because ${unsafe.map((branch) => `${branch.name}: ${branch.reason}`).join("; ")}.`,
      unsafe
    );
  }

  const updates = localUpdates(inventory, repo);
  const targetCheckout = await checkoutAfterGet(repo, currentBranch, remoteDefaultBranch, inventory);
  const created = inventory.filter((branch) => branch.relation === "remote-only").map((branch) => branch.name);
  const fastForwarded = inventory.filter((branch) => branch.relation === "remote-ahead").map((branch) => branch.name);
  const deleted = inventory
    .filter((branch) => branch.relation === "remotely-deleted" && branch.localTip)
    .map((branch) => branch.name);
  const currentRef = repo.localRef(currentBranch);
  const replaceCheckout = updates.some((update) => update.ref === currentRef);
  const plan = createOperationPlan({
    command: "Get from Remote",
    localRefUpdates: updates,
    checkout: { before: currentBranch, after: targetCheckout },
    destructiveEffects: [
      ...deleted.map((branch) => ({
        kind: "delete-local-ref" as const,
        ref: repo.localRef(branch),
        description: `Delete local branch ${branch} after proving it still matches the previously fetched remote tip`,
      })),
      ...(targetCheckout !== currentBranch ? [{
        kind: "replace-checkout" as const,
        ref: repo.localRef(currentBranch),
        description: `Replace the deleted checkout ${currentBranch} with ${targetCheckout}`,
      }] : []),
    ],
  });
  await beginOperation(repo, plan);

  if (!mapsEqual(fetchedRemoteTips, await snapshotRemoteTips(repo, configuration.remote))) {
    return fail(
      "REMOTE_TRACKING_CHANGED",
      "Remote-tracking refs changed after Get from Remote classified them. Inspect the incomplete operation and retry."
    );
  }
  if (updates.length && (await repo.statusPorcelain()).trim()) {
    return fail(
      "WORKTREE_CHANGED_DURING_GET",
      "The working tree changed after Get from Remote preflight. Inspect the incomplete operation before retrying."
    );
  }

  if (replaceCheckout) {
    await withMutationBoundary(repo, plan.operationId, "checkout", () => repo.detach());
  }
  if (updates.length) {
    await applyLocalRefTransaction(repo, plan);
  }
  if (created.length) {
    await withMutationBoundary(repo, plan.operationId, "configuration", async () => {
      for (const branch of created) {
        await repo.configureTracking(branch, configuration.remote);
      }
    });
  }
  if (replaceCheckout) {
    await withMutationBoundary(repo, plan.operationId, "checkout", () => repo.switch(targetCheckout));
  }

  await verifyBranchParity(repo, configuration.remote);
  const currentInventory = await inspectBranchInventory(
    repo,
    configuration.remote,
    await snapshotRemoteTips(repo, configuration.remote)
  );
  const advisories = await parentAdvisories(repo, remoteDefaultBranch, currentInventory);
  await completeOperation(repo, plan.operationId);
  return {
    operationId: plan.operationId,
    updated: updates.length > 0,
    checkout: targetCheckout,
    created,
    fastForwarded,
    deleted,
    advisories,
  };
}
